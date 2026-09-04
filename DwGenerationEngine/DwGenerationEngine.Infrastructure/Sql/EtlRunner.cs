using Microsoft.Data.SqlClient;
using DwGenerationEngine.Core.Interfaces;
using DwGenerationEngine.Core.Models;
using DwGenerationEngine.Core.Services;

namespace DwGenerationEngine.Infrastructure.Sql;

public class EtlRunner : IEtlRunner
{
    private readonly ISqlConnectionFactory _connectionFactory;

    public EtlRunner(ISqlConnectionFactory connectionFactory)
    {
        _connectionFactory = connectionFactory;
    }

    public async Task<EtlResult> RunAsync(SchemaProposal schema)
    {
        var result = new EtlResult { Success = true };

        using var connection = await _connectionFactory.CreateConnectionAsync(schema.DwDatabase);
        using var transaction = connection.BeginTransaction();

        try
        {
            // 0. DELETE dans l'ordre inverse du peuplement : Facts -> Dimensions -> SubDimensions -> GeneratedDimensions
            await TruncateAllAsync(connection, transaction, schema);

            // 1. GeneratedDimensions (DimTemps) : dates distinctes extraites des colonnes sources des faits
            foreach (var gd in schema.GeneratedDimensions)
            {
                var tableResult = await LoadGeneratedTimeDimensionAsync(connection, transaction, schema, gd);
                result.Tables.Add(tableResult);
            }

            // 2. SubDimensions : valeurs distinctes extraites DIRECTEMENT DU STAGING (vraie déduplication)
            foreach (var sd in schema.SubDimensions)
            {
                var tableResult = await LoadSubDimensionAsync(connection, transaction, schema.StagingDatabase, sd, schema.TableRenames);
                result.Tables.Add(tableResult);
            }

            // 3. Dimensions simples : copie staging -> DW, avec lookup FK vers leurs sous-dimensions
         foreach (var dimName in schema.Dimensions)
            {
                var isVirtual = schema.VirtualDimensions.Any(vd => vd.Name == dimName);
                if (isVirtual)
                {
                    result.Tables.Add(new EtlTableResult
                    {
                        TableName = dimName,
                        RowsInserted = 0,
                        Warnings = { "Dimension virtuelle (structure uniquement, sans source staging) — à peupler manuellement." }
                    });
                    continue;
                }

                var attributes = schema.TableAttributes.GetValueOrDefault(dimName, new List<TableAttribute>());
                var subDimsForThisTable = schema.SubDimensions.Where(sd => sd.ParentDimension == dimName).ToList();
                var tableResult = await LoadSimpleDimensionAsync(connection, transaction, schema.StagingDatabase, dimName, attributes, subDimsForThisTable, schema.ColumnTransformations, schema.TableRenames);
                result.Tables.Add(tableResult);
            }

            // 4. Faits : lookup des clés naturelles -> clés de substitution
            var allFactLinks = FactRelationResolver.Resolve(schema);

            foreach (var factName in schema.Facts)
{
    var isVirtual = schema.VirtualFacts.Any(vf => vf.Name == factName);
    if (isVirtual)
    {
        result.Tables.Add(new EtlTableResult
        {
            TableName = factName,
            RowsInserted = 0,
            Warnings = { "Fait virtuel (structure uniquement, sans source staging) — à peupler manuellement." }
        });
        continue;
    }

    var attributes = schema.TableAttributes.GetValueOrDefault(factName, new List<TableAttribute>());
    var transformations = schema.FactColumnTransformations.Where(t => t.FactTable == factName).ToList();
    var factLinks = allFactLinks.Where(l => l.FactTable == factName).ToList();

    var tableResult = await LoadFactTableAsync(
    connection, transaction, schema.StagingDatabase, factName, attributes, transformations, factLinks, schema.ColumnTransformations, schema.TableRenames);
    result.Tables.Add(tableResult);
}

            transaction.Commit();
            return result;
        }
        catch (Exception ex)
        {
            try { transaction.Rollback(); }
            catch { /* la connexion peut déjà être dans un état invalide, on ignore */ }

            result.Success = false;
            result.Errors.Add(ex.Message);
            return result;
        }
    }

    // ---------- Utilitaire de nommage staging ----------

    private static string StagingTableName(string dwTableName) => $"staging_{dwTableName}";

    // ✅ NOUVEAU : résout le VRAI nom de table staging d'une table du DW, en tenant compte
    // des renommages effectués via le chat. Sans ça, une table renommée (ex: "FactSales" -> "sales")
    // fait chercher l'ETL dans "staging_sales" (qui n'existe pas) au lieu de "staging_FactSales".
    private static string ResolveStagingTableName(string dwTableName, List<TableRename>? tableRenames)
    {
        var renameEntry = tableRenames?.FirstOrDefault(tr =>
            string.Equals(tr.DisplayName, dwTableName, StringComparison.OrdinalIgnoreCase));

        return renameEntry != null ? renameEntry.StagingTable : StagingTableName(dwTableName);
    }

    // ---------- DELETE (vidage avant rechargement) ----------

    private static async Task TruncateAllAsync(SqlConnection connection, SqlTransaction transaction, SchemaProposal schema)
    {
        // DELETE au lieu de TRUNCATE : TRUNCATE refuse de vider une table dès qu'une FK
        // existe vers elle, même si la table qui référence est vide ou pas encore vidée.
        var deleteOrder = schema.Facts.Where(f => !schema.VirtualFacts.Any(vf => vf.Name == f))
            .Concat(schema.Dimensions)
            .Concat(schema.SubDimensions.Select(sd => sd.Name))
            .Concat(schema.GeneratedDimensions.Select(gd => gd.Name));

        foreach (var tableName in deleteOrder)
        {
            var sql = $"DELETE FROM [dbo].[{tableName}];";
            await ExecuteNonQueryAsync(connection, transaction, sql);
        }


    }

    // ---------- DimTemps (dimension temporelle générée) ----------

    private static async Task<EtlTableResult> LoadGeneratedTimeDimensionAsync(
        SqlConnection connection, SqlTransaction transaction, SchemaProposal schema, GeneratedDimension dim)
    {
        var pkColumn = dim.Columns.First(c => c.IsPrimaryKey).Name;
        var dateColumn = dim.Columns.First(c => !c.IsPrimaryKey).Name;

        var sourceColumns = schema.FactColumnTransformations
            .Where(t => t.ReferencesTable == dim.Name)
            .Select(t => (t.FactTable, t.OriginalColumn))
            .ToList();

        if (sourceColumns.Count == 0)
        {
            return new EtlTableResult
            {
                TableName = dim.Name,
                RowsInserted = 0,
                Warnings = { $"Aucune colonne source trouvée pour {dim.Name}, dimension non peuplée." }
            };
        }

        // ✅ CORRIGÉ : résout le vrai nom staging de chaque table de fait (via tableRenames),
        // au lieu de préfixer "staging_" sur le nom d'affichage courant.
        var unions = sourceColumns.Select(sc =>
            $"SELECT DISTINCT [{sc.OriginalColumn}] AS DateValue FROM [{schema.StagingDatabase}].[dbo].[{ResolveStagingTableName(sc.FactTable, schema.TableRenames)}] WHERE [{sc.OriginalColumn}] IS NOT NULL");

        var sql = $@"
            INSERT INTO [dbo].[{dim.Name}] ([{pkColumn}], [{dateColumn}])
            SELECT DISTINCT CONVERT(INT, FORMAT(DateValue, 'yyyyMMdd')), CAST(DateValue AS DATE)
            FROM ({string.Join(" UNION ", unions)}) AS AllDates;";

        var rows = await ExecuteNonQueryAsync(connection, transaction, sql);
        return new EtlTableResult { TableName = dim.Name, RowsInserted = rows };
    }

    // ---------- Sous-dimensions (lues depuis le staging, vraie déduplication) ----------

    private static async Task<EtlTableResult> LoadSubDimensionAsync(
        SqlConnection connection, SqlTransaction transaction, string stagingDb, SubDimension sd, List<TableRename>? tableRenames)
    {
        // ✅ CORRIGÉ : résout le vrai nom staging de la dimension parente, au lieu de préfixer
        // "staging_" sur son nom d'affichage courant (qui peut avoir été renommé via le chat).
        var stagingTable = ResolveStagingTableName(sd.ParentDimension, tableRenames);

        var sql = $@"
            INSERT INTO [dbo].[{sd.Name}] ([{sd.SourceColumn}])
            SELECT DISTINCT [{sd.SourceColumn}]
            FROM [{stagingDb}].[dbo].[{stagingTable}]
            WHERE [{sd.SourceColumn}] IS NOT NULL;";

        var rows = await ExecuteNonQueryAsync(connection, transaction, sql);
        return new EtlTableResult { TableName = sd.Name, RowsInserted = rows };
    }

    // ---------- Dimensions simples (avec lookup vers leurs sous-dimensions) ----------

    private static async Task<EtlTableResult> LoadSimpleDimensionAsync(
    SqlConnection connection, SqlTransaction transaction, string stagingDb, string tableName,
    List<TableAttribute> attributes, List<SubDimension> subDims,
    List<RealColumnTransformation> columnTransformations,
    List<TableRename>? tableRenames) // ✅ NOUVEAU
{
    // ✅ CORRIGÉ : résout le vrai nom staging de cette table (via tableRenames), au lieu de
    // préfixer "staging_" sur le nom d'affichage courant qui peut avoir été renommé via le chat.
    var stagingTable = ResolveStagingTableName(tableName, tableRenames);
    var subDimSourceColumns = subDims.Select(sd => sd.SourceColumn).ToHashSet(StringComparer.OrdinalIgnoreCase);

    var transformsByNewName = columnTransformations
        .Where(t => t.Table == tableName)
        .ToDictionary(t => t.NewColumn, t => t.OriginalColumn, StringComparer.OrdinalIgnoreCase);

    var normalAttributes = attributes
        .Where(a => !subDimSourceColumns.Contains(a.Name))
        .ToList();

    // Colonne DW = a.Name (déjà renommée si transformée) ; colonne source staging = mapping si transformée, sinon identique
    var normalInsertColumns = normalAttributes.Select(a => a.Name).ToList();
    var normalSelectExpressions = normalAttributes
        .Select(a => transformsByNewName.TryGetValue(a.Name, out var originalCol)
            ? $"s.[{originalCol}]"
            : $"s.[{a.Name}]")
        .ToList();

    var joins = new List<string>();
    var subDimSelectColumns = new List<string>();
    var subDimInsertColumns = new List<string>();
    int aliasIndex = 0;

    foreach (var sd in subDims)
    {
        var alias = $"sd{aliasIndex++}";
        joins.Add($"LEFT JOIN [dbo].[{sd.Name}] {alias} ON s.[{sd.SourceColumn}] = {alias}.[{sd.SourceColumn}]");
        subDimSelectColumns.Add($"{alias}.[{sd.GeneratedPrimaryKey}]");
        subDimInsertColumns.Add(sd.GeneratedPrimaryKey);
    }

    var insertColumns = normalInsertColumns.Concat(subDimInsertColumns);
    var selectColumns = normalSelectExpressions.Concat(subDimSelectColumns);

    var sql = $@"
        INSERT INTO [dbo].[{tableName}] ({string.Join(", ", insertColumns.Select(c => $"[{c}]"))})
        SELECT {string.Join(", ", selectColumns)}
        FROM [{stagingDb}].[dbo].[{stagingTable}] s
        {string.Join("\n", joins)};";

    var rows = await ExecuteNonQueryAsync(connection, transaction, sql);
    return new EtlTableResult { TableName = tableName, RowsInserted = rows };
}
    // ---------- Faits ----------

    private static async Task<EtlTableResult> LoadFactTableAsync(
    SqlConnection connection,
    SqlTransaction transaction,
    string stagingDb,
    string factName,
    List<TableAttribute> attributes,
    List<FactColumnTransformation> transformations,
    List<FactDimensionLink> factLinks,
    List<RealColumnTransformation> columnTransformations,
    List<TableRename>? tableRenames) // ✅ NOUVEAU
{
    var warnings = new List<string>();
    // ✅ CORRIGÉ : résout le vrai nom staging de ce fait (via tableRenames), au lieu de
    // préfixer "staging_" sur le nom d'affichage courant — c'est le bug exact qui causait
    // "Nom d'objet 'test3.dbo.staging_sales' non valide." après renommage FactSales -> sales.
    var stagingTable = ResolveStagingTableName(factName, tableRenames);

    var excludedColumns = transformations.Select(t => t.OriginalColumn)
        .Concat(factLinks.Select(l => l.NaturalKeyColumn))
        .ToHashSet(StringComparer.OrdinalIgnoreCase);

    var transformsByNewName = columnTransformations
        .Where(t => t.Table == factName)
        .ToDictionary(t => t.NewColumn, t => t.OriginalColumn, StringComparer.OrdinalIgnoreCase);

    var normalAttributes = attributes
        .Where(a => !excludedColumns.Contains(a.Name))
        .ToList();

    var normalInsertColumns = normalAttributes.Select(a => a.Name).ToList();
    var normalSelectExpressions = normalAttributes
        .Select(a => transformsByNewName.TryGetValue(a.Name, out var originalCol)
            ? $"s.[{originalCol}]"
            : $"s.[{a.Name}]")
        .ToList();

    var timeJoins = new List<string>();
    var timeSelectColumns = new List<string>();
    var timeInsertColumns = new List<string>();
    int timeAliasIndex = 0;

    foreach (var t in transformations)
    {
        var alias = $"td{timeAliasIndex++}";
        timeJoins.Add(
            $"LEFT JOIN [dbo].[{t.ReferencesTable}] {alias} ON CONVERT(INT, FORMAT(s.[{t.OriginalColumn}], 'yyyyMMdd')) = {alias}.[{t.ReferencesColumn}]");
        timeSelectColumns.Add($"{alias}.[{t.ReferencesColumn}]");
        timeInsertColumns.Add(t.NewColumn);
    }

    var dimJoins = new List<string>();
    var dimSelectColumns = new List<string>();
    var dimInsertColumns = new List<string>();
    int dimAliasIndex = 0;

    foreach (var l in factLinks)
    {
        var alias = $"dd{dimAliasIndex++}";
        dimJoins.Add(
            $"LEFT JOIN [dbo].[{l.DimensionTable}] {alias} ON s.[{l.NaturalKeyColumn}] = {alias}.[{l.DimensionNaturalKeyColumn}]");
        dimSelectColumns.Add($"{alias}.[{l.DimensionSurrogateKeyColumn}]");
        dimInsertColumns.Add(l.NewFactColumnName);
    }

    var insertColumns = normalInsertColumns.Concat(timeInsertColumns).Concat(dimInsertColumns);
    var selectColumns = normalSelectExpressions
        .Concat(timeSelectColumns)
        .Concat(dimSelectColumns);
    var allJoins = timeJoins.Concat(dimJoins);

    var sql = $@"
        INSERT INTO [dbo].[{factName}] ({string.Join(", ", insertColumns.Select(c => $"[{c}]"))})
        SELECT {string.Join(", ", selectColumns)}
        FROM [{stagingDb}].[dbo].[{stagingTable}] s
        {string.Join("\n", allJoins)};";

    var rows = await ExecuteNonQueryAsync(connection, transaction, sql);

    foreach (var l in factLinks)
    {
        var checkSql = $@"
            SELECT COUNT(*) FROM [dbo].[{factName}] f
            WHERE f.[{l.NewFactColumnName}] IS NULL;";
        var orphanCount = await ExecuteScalarAsync(connection, transaction, checkSql);
        if (orphanCount > 0)
        {
            warnings.Add($"{orphanCount} ligne(s) sans correspondance pour {l.NewFactColumnName} (FK laissée à NULL).");
        }
    }
    return new EtlTableResult { TableName = factName, RowsInserted = rows, Warnings = warnings };
}

    // ---------- Utilitaires ----------

    private static async Task<int> ExecuteNonQueryAsync(SqlConnection connection, SqlTransaction transaction, string sql)
    {
        using var command = new SqlCommand(sql, connection, transaction) { CommandTimeout = 120 };
        return await command.ExecuteNonQueryAsync();
    }

    private static async Task<int> ExecuteScalarAsync(SqlConnection connection, SqlTransaction transaction, string sql)
    {
        using var command = new SqlCommand(sql, connection, transaction) { CommandTimeout = 120 };
        var result = await command.ExecuteScalarAsync();
        return Convert.ToInt32(result);
    }
}