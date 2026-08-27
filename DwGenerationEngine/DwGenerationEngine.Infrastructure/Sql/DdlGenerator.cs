using System.Text;
using Microsoft.Data.SqlClient;
using DwGenerationEngine.Core.Interfaces;
using DwGenerationEngine.Core.Models;
using DwGenerationEngine.Core.Services;

namespace DwGenerationEngine.Infrastructure.Sql;

public class DdlGenerator : IDdlGenerator
{
    private readonly ISqlConnectionFactory _connectionFactory;

    public DdlGenerator(ISqlConnectionFactory connectionFactory)
    {
        _connectionFactory = connectionFactory;
    }
    private static async Task DropAllForeignKeysAsync(SqlConnection connection, List<string> tableNames)
{
    var tableList = string.Join(",", tableNames.Select(t => $"'{t}'"));

    var findFksSql = $@"
        SELECT fk.name AS FkName, tp.name AS TableName
        FROM sys.foreign_keys fk
        JOIN sys.tables tp ON fk.parent_object_id = tp.object_id
        WHERE tp.name IN ({tableList});";

    var fksToDrop = new List<(string FkName, string TableName)>();

    using (var command = new SqlCommand(findFksSql, connection))
    using (var reader = await command.ExecuteReaderAsync())
    {
        while (await reader.ReadAsync())
        {
            fksToDrop.Add((reader.GetString(0), reader.GetString(1)));
        }
    }

    foreach (var (fkName, tableName) in fksToDrop)
    {
        var dropFkSql = $"ALTER TABLE [dbo].[{tableName}] DROP CONSTRAINT [{fkName}];";
        await ExecuteNonQueryAsync(connection, dropFkSql);
    }
}

    public async Task<DdlGenerationResult> GenerateAsync(SchemaProposal schema)
    {
        var result = new DdlGenerationResult { Success = true };

        try
        {
            await EnsureDatabaseExistsAsync(schema.DwDatabase);

            using var connection = await _connectionFactory.CreateConnectionAsync(schema.DwDatabase);

            // 1. DROP dans l'ordre inverse des dépendances FK : Facts -> Dimensions -> SubDimensions -> GeneratedDimensions
            var dropOrder = new List<string>();
            dropOrder.AddRange(schema.Facts);
            dropOrder.AddRange(schema.Dimensions);
            dropOrder.AddRange(schema.SubDimensions.Select(sd => sd.Name));
            dropOrder.AddRange(schema.GeneratedDimensions.Select(gd => gd.Name));
            // Supprime d'abord toutes les contraintes FK sur les tables du schéma,
            // pour éviter les erreurs de DROP liées à un ancien sens de dépendance
            // (ex: transition d'un ancien schéma où DimCity référençait Customers).
            var allTableNames = schema.Facts
                .Concat(schema.Dimensions)
                .Concat(schema.SubDimensions.Select(sd => sd.Name))
                .Concat(schema.GeneratedDimensions.Select(gd => gd.Name))
                .ToList();
            // Nettoie les tables orphelines d'un schéma précédent qui ne font plus partie du schéma actuel
            result.DroppedOrphanTables = await DropOrphanTablesAsync(connection, allTableNames);   // ← LIGNE MANQUANTE À AJOUTER

            await DropAllForeignKeysAsync(connection, allTableNames);
            foreach (var tableName in dropOrder)
            {
                var dropSql = $"IF OBJECT_ID('dbo.[{tableName}]', 'U') IS NOT NULL DROP TABLE [dbo].[{tableName}];";
                await ExecuteNonQueryAsync(connection, dropSql);
                result.ExecutedScripts.Add(dropSql);
            }

            // 2. CREATE dans l'ordre : GeneratedDimensions -> SubDimensions -> Dimensions -> Facts
            foreach (var gd in schema.GeneratedDimensions)
            {
                var sql = BuildGeneratedDimensionCreateScript(gd);
                await ExecuteNonQueryAsync(connection, sql);
                result.ExecutedScripts.Add(sql);
                result.CreatedTables.Add(gd.Name);
            }

            foreach (var sd in schema.SubDimensions)
            {
                var sql = BuildSubDimensionCreateScript(sd);
                await ExecuteNonQueryAsync(connection, sql);
                result.ExecutedScripts.Add(sql);
                result.CreatedTables.Add(sd.Name);
            }

            foreach (var dimName in schema.Dimensions)
            {
                var attributes = schema.TableAttributes.GetValueOrDefault(dimName, new List<TableAttribute>());
                var subDimsForThisTable = schema.SubDimensions
                    .Where(sd => sd.ParentDimension == dimName)
                    .ToList();
                var sql = BuildSimpleTableCreateScript(dimName, attributes, subDimsForThisTable);
                await ExecuteNonQueryAsync(connection, sql);
                result.ExecutedScripts.Add(sql);
                result.CreatedTables.Add(dimName);
            }

            var allFactLinks = FactRelationResolver.Resolve(schema);

            foreach (var factName in schema.Facts)
            {
                var attributes = schema.TableAttributes.GetValueOrDefault(factName, new List<TableAttribute>());
                var transformations = schema.FactColumnTransformations
                    .Where(t => t.FactTable == factName)
                    .ToList();
                var factLinks = allFactLinks
                    .Where(l => l.FactTable == factName)
                    .ToList();

                var sql = BuildFactTableCreateScript(factName, attributes, transformations, factLinks);
                await ExecuteNonQueryAsync(connection, sql);
                result.ExecutedScripts.Add(sql);
                result.CreatedTables.Add(factName);
            }

            return result;
        }
        catch (Exception ex)
        {
            result.Success = false;
            result.Errors.Add(ex.Message);
            return result;
        }
    }

    // ---------- Construction des scripts CREATE TABLE ----------

    private static string BuildGeneratedDimensionCreateScript(GeneratedDimension dim)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"CREATE TABLE [dbo].[{dim.Name}] (");

        var columnDefs = dim.Columns.Select(col =>
        {
            var def = $"    [{col.Name}] {col.Type}";
            if (col.IsPrimaryKey)
            {
                // Pas d'IDENTITY : la clé d'une dimension générée (ex: DimTemps.DateKey)
                // est calculée depuis la donnée source (ex: 20260115), pas auto-incrémentée.
                def += " PRIMARY KEY";
            }
            return def;
        });

        sb.AppendLine(string.Join(",\n", columnDefs));
        sb.AppendLine(");");
        return sb.ToString();
    }

    private static string BuildSimpleTableCreateScript(string tableName, List<TableAttribute> attributes, List<SubDimension> subDims)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"CREATE TABLE [dbo].[{tableName}] (");

        var pkColumnName = $"{tableName}Id";
        var subDimSourceColumns = subDims.Select(sd => sd.SourceColumn).ToHashSet(StringComparer.OrdinalIgnoreCase);

        var columnDefs = new List<string>
        {
            $"    [{pkColumnName}] INT IDENTITY(1,1) PRIMARY KEY"
        };

        // Colonnes staging normales, sauf celles remplacées par une FK vers une sous-dimension
        columnDefs.AddRange(
            attributes
                .Where(a => !subDimSourceColumns.Contains(a.Name))
                .Select(a => $"    [{a.Name}] {a.Type}")
        );

        // FK vers chaque sous-dimension rattachée à cette table
        columnDefs.AddRange(
            subDims.Select(sd =>
                $"    [{sd.GeneratedPrimaryKey}] INT NULL FOREIGN KEY REFERENCES [dbo].[{sd.Name}]([{sd.GeneratedPrimaryKey}])")
        );

        sb.AppendLine(string.Join(",\n", columnDefs));
        sb.AppendLine(");");
        return sb.ToString();
    }

    private static string BuildSubDimensionCreateScript(SubDimension sd)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"CREATE TABLE [dbo].[{sd.Name}] (");
        sb.AppendLine($"    [{sd.GeneratedPrimaryKey}] INT IDENTITY(1,1) PRIMARY KEY,");
        sb.AppendLine($"    [{sd.SourceColumn}] NVARCHAR(255) NOT NULL UNIQUE");
        sb.AppendLine(");");
        return sb.ToString();
    }

    private static string BuildFactTableCreateScript(
        string factName,
        List<TableAttribute> attributes,
        List<FactColumnTransformation> transformations,
        List<FactDimensionLink> factLinks)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"CREATE TABLE [dbo].[{factName}] (");

        var columnDefs = new List<string>
        {
            $"    [{factName}Id] INT IDENTITY(1,1) PRIMARY KEY"
        };

        var excludedColumns = transformations
            .Select(t => t.OriginalColumn)
            .Concat(factLinks.Select(l => l.NaturalKeyColumn))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        columnDefs.AddRange(
            attributes
                .Where(a => !excludedColumns.Contains(a.Name))
                .Select(a => $"    [{a.Name}] {a.Type}")
        );

        columnDefs.AddRange(
            transformations.Select(t =>
                $"    [{t.NewColumn}] {t.NewColumnType} FOREIGN KEY REFERENCES [dbo].[{t.ReferencesTable}]([{t.ReferencesColumn}])")
        );

        columnDefs.AddRange(
            factLinks.Select(l =>
                $"    [{l.NewFactColumnName}] INT NULL FOREIGN KEY REFERENCES [dbo].[{l.DimensionTable}]([{l.DimensionSurrogateKeyColumn}])")
        );

        sb.AppendLine(string.Join(",\n", columnDefs));
        sb.AppendLine(");");
        return sb.ToString();
    }

    // ---------- Utilitaires ----------

    private async Task EnsureDatabaseExistsAsync(string databaseName)
    {
        using var masterConnection = await _connectionFactory.CreateMasterConnectionAsync();
        var sql = $@"
            IF NOT EXISTS (SELECT name FROM sys.databases WHERE name = '{databaseName}')
            BEGIN
                CREATE DATABASE [{databaseName}];
            END";
        await ExecuteNonQueryAsync(masterConnection, sql);
    }

    private static async Task ExecuteNonQueryAsync(SqlConnection connection, string sql)
    {
        using var command = new SqlCommand(sql, connection);
        await command.ExecuteNonQueryAsync();
    }
    private static async Task<List<string>> DropOrphanTablesAsync(SqlConnection connection, List<string> expectedTableNames)
{
    var existingTablesSql = "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE';";
    var existingTables = new List<string>();

    using (var command = new SqlCommand(existingTablesSql, connection))
    using (var reader = await command.ExecuteReaderAsync())
    {
        while (await reader.ReadAsync())
        {
            existingTables.Add(reader.GetString(0));
        }
    }

    var orphanTables = existingTables
        .Where(t => !expectedTableNames.Contains(t, StringComparer.OrdinalIgnoreCase))
        .ToList();

    if (orphanTables.Count == 0) return orphanTables;

    // Supprime d'abord toutes les FK des tables orphelines (elles peuvent référencer
    // ou être référencées par d'autres tables), puis les tables elles-mêmes.
    await DropAllForeignKeysAsync(connection, orphanTables);

    foreach (var tableName in orphanTables)
    {
        var dropSql = $"IF OBJECT_ID('dbo.[{tableName}]', 'U') IS NOT NULL DROP TABLE [dbo].[{tableName}];";
        await ExecuteNonQueryAsync(connection, dropSql);
    }

    return orphanTables;
}
}