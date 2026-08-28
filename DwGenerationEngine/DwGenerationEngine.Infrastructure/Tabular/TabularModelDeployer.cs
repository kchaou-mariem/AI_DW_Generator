using Microsoft.AnalysisServices.Tabular;
using Microsoft.Extensions.Configuration;
using DwGenerationEngine.Core.Interfaces;
using DwGenerationEngine.Core.Models;
using DwGenerationEngine.Core.Services;

// Alias explicites pour lever les ambiguïtés entre AMO (Microsoft.AnalysisServices)
// et TOM (Microsoft.AnalysisServices.Tabular), qui définissent tous les deux des types
// portant le même nom (Server, Database, ImpersonationMode...).
using TabularServer = Microsoft.AnalysisServices.Tabular.Server;
using TabularDatabase = Microsoft.AnalysisServices.Tabular.Database;
using TabularImpersonationMode = Microsoft.AnalysisServices.Tabular.ImpersonationMode;
using AmoUpdateOptions = Microsoft.AnalysisServices.UpdateOptions;

namespace DwGenerationEngine.Infrastructure.Tabular;

public class TabularModelDeployer : ITabularModelDeployer
{
    private readonly string _tabularServer;
    private readonly string _sqlServer;
    private readonly string _sqlUser;
    private readonly string _sqlPassword;

    public TabularModelDeployer(IConfiguration configuration)
    {
        _tabularServer = configuration["Tabular:Server"] ?? throw new InvalidOperationException("Tabular:Server manquant dans la configuration");
        _sqlServer = configuration["Database:Server"] ?? "localhost";
        _sqlUser = configuration["Database:User"] ?? "sa";
        _sqlPassword = configuration["Database:Password"] ?? throw new InvalidOperationException("Database:Password manquant");
    }

public Task<TabularDeployResult> DeployAsync(SchemaProposal schema)
{
    var result = new TabularDeployResult { Success = true };

    using var server = new TabularServer();
    try
    {
        server.Connect($"Data Source={_tabularServer}");

        // Supprime le modèle existant s'il y en a un du même nom (redéploiement propre)
        var existing = server.Databases.FindByName(schema.DwDatabase);
        existing?.Drop();

        var database = new TabularDatabase(schema.DwDatabase)
        {
            ID = schema.DwDatabase,
            CompatibilityLevel = 1500,
            Model = new Model()
        };

        var dataSource = new ProviderDataSource
        {
            Name = "DwSqlSource",
            ConnectionString = $"Provider=MSOLEDBSQL;Data Source={_sqlServer};Initial Catalog={schema.DwDatabase};User ID={_sqlUser};Password={_sqlPassword};",
            ImpersonationMode = TabularImpersonationMode.ImpersonateServiceAccount,
        };
        database.Model.DataSources.Add(dataSource);

        var allTableNames = schema.GeneratedDimensions.Select(gd => gd.Name)
            .Concat(schema.SubDimensions.Select(sd => sd.Name))
            .Concat(schema.Dimensions)
            .Concat(schema.Facts)
            .ToList();

        foreach (var tableName in allTableNames)
        {
            var table = BuildTable(tableName, schema, dataSource);
            database.Model.Tables.Add(table);
            result.CreatedTables.Add(tableName);
        }

        // Relations : sous-dimension -> dimension parente
        // NB: FromTable/ToTable sont calculés automatiquement à partir de FromColumn/ToColumn
        // (Relationship.FromTable/ToTable sont en lecture seule dans le TOM) -> ne jamais les assigner.
        foreach (var sd in schema.SubDimensions)
        {
            var rel = new SingleColumnRelationship
            {
                Name = $"{sd.ParentDimension}_{sd.Name}",
                FromColumn = database.Model.Tables[sd.ParentDimension].Columns[sd.GeneratedPrimaryKey],
                ToColumn = database.Model.Tables[sd.Name].Columns[sd.GeneratedPrimaryKey],
            };
            database.Model.Relationships.Add(rel);
            result.CreatedRelationships.Add(rel.Name);
        }

        // Relations : fait -> DimTemps (via FactColumnTransformations)
        foreach (var t in schema.FactColumnTransformations)
        {
            var rel = new SingleColumnRelationship
            {
                Name = $"{t.FactTable}_{t.ReferencesTable}_{t.NewColumn}",
                FromColumn = database.Model.Tables[t.FactTable].Columns[t.NewColumn],
                ToColumn = database.Model.Tables[t.ReferencesTable].Columns[t.ReferencesColumn],
            };
            database.Model.Relationships.Add(rel);
            result.CreatedRelationships.Add(rel.Name);
        }

        // Relations : fait -> dimension (via ConfirmedRelations, résolu par FactRelationResolver)
        // Si la "dimension" cible est en réalité une sous-dimension (colonne normalisée),
        // on ne crée JAMAIS de lien direct fait -> sous-dimension : le chemin indirect
        // fait -> dimension parente -> sous-dimension existe toujours (DdlGenerator crée
        // systématiquement cette FK), et Tabular interdit les chemins ambigus entre deux tables.
        var subDimParentLookup = schema.SubDimensions.ToDictionary(sd => sd.Name, sd => sd.ParentDimension, StringComparer.OrdinalIgnoreCase);

        foreach (var link in FactRelationResolver.Resolve(schema))
        {
            if (subDimParentLookup.ContainsKey(link.DimensionTable))
            {
                // Chemin indirect toujours disponible : fait -> dimension parente -> sous-dimension.
                // On saute systématiquement la relation directe.
                continue;
            }

            var rel = new SingleColumnRelationship
            {
                Name = $"{link.FactTable}_{link.DimensionTable}_{link.NewFactColumnName}",
                FromColumn = database.Model.Tables[link.FactTable].Columns[link.NewFactColumnName],
                ToColumn = database.Model.Tables[link.DimensionTable].Columns[link.DimensionSurrogateKeyColumn],
            };
            database.Model.Relationships.Add(rel);
            result.CreatedRelationships.Add(rel.Name);
        }

        // Mesures : SUM + AVERAGE sur chaque colonne numérique de chaque fait, + COUNTROWS
        foreach (var factName in schema.Facts)
        {
            var factTable = database.Model.Tables[factName];
            var numericColumns = DwTableSchemaResolver.GetNumericMeasureColumns(factName, schema);

            foreach (var col in numericColumns)
            {
                // Le nom de la table de fait est inclus dans le nom de la mesure : les mesures
                // doivent être uniques dans tout le modèle (contrairement aux colonnes, qui
                // peuvent partager un nom entre tables différentes, ex: OrderQuantity dans
                // FactSales et Sales).
                var sumMeasure = new Measure
                {
                    Name = $"Somme de {col} ({factName})",
                    Expression = $"SUM('{factName}'[{col}])"
                };
                factTable.Measures.Add(sumMeasure);
                result.CreatedMeasures.Add(sumMeasure.Name);

                var avgMeasure = new Measure
                {
                    Name = $"Moyenne de {col} ({factName})",
                    Expression = $"AVERAGE('{factName}'[{col}])"
                };
                factTable.Measures.Add(avgMeasure);
                result.CreatedMeasures.Add(avgMeasure.Name);
            }

            var countMeasure = new Measure
            {
                Name = $"Nombre de {factName}",
                Expression = $"COUNTROWS('{factName}')"
            };
            factTable.Measures.Add(countMeasure);
            result.CreatedMeasures.Add(countMeasure.Name);
        }

        server.Databases.Add(database);
        database.Update(AmoUpdateOptions.ExpandFull);

        // Traitement complet (Process Full) : charge les données depuis le DW
        database.Model.RequestRefresh(RefreshType.Full);
        database.Model.SaveChanges();

        return Task.FromResult(result);
    }
    catch (Exception ex)
    {
        result.Success = false;
        result.Errors.Add(ex.Message);
        return Task.FromResult(result);
    }
    finally
    {
        server.Disconnect();
    }
}

    private static Table BuildTable(string tableName, SchemaProposal schema, ProviderDataSource dataSource)
    {
        var table = new Table { Name = tableName };

        var partition = new Partition
        {
            Name = tableName,
            Source = new QueryPartitionSource
            {
                DataSource = dataSource,
                Query = $"SELECT * FROM [dbo].[{tableName}]"
            }
        };
        table.Partitions.Add(partition);

        foreach (var col in DwTableSchemaResolver.GetColumns(tableName, schema))
        {
            table.Columns.Add(new DataColumn
            {
                Name = col.Name,
                SourceColumn = col.Name,
                DataType = MapDataType(col.SqlType)
            });
        }

        return table;
    }

   private static DataType MapDataType(string sqlType)
{
    var t = sqlType.ToUpperInvariant();
    if (t.Contains("BIGINT")) return DataType.Int64;
    if (t.Contains("INT")) return DataType.Int64;
    if (t.Contains("DECIMAL") || t.Contains("NUMERIC")) return DataType.Decimal;
    if (t.Contains("FLOAT") || t.Contains("REAL")) return DataType.Double;
    if (t.Contains("DATE")) return DataType.DateTime; // couvre DATE, DATETIME, DATETIME2
    if (t.Contains("BIT") || t.Contains("BOOL")) return DataType.Boolean;
    return DataType.String; // VARCHAR, NVARCHAR, NVARCHAR(MAX), et tout type non reconnu
}
}