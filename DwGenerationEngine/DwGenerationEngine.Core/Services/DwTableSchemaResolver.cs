using DwGenerationEngine.Core.Models;

namespace DwGenerationEngine.Core.Services;

public record ResolvedColumn(string Name, string SqlType);

/// <summary>
/// Calcule la liste réelle des colonnes de chaque table du DW (dimensions, sous-dimensions,
/// dimensions générées, faits), en miroir exact de ce que DdlGenerator crée en SQL.
/// Utilisé par le déploiement du modèle Tabular pour créer des colonnes cohérentes avec le DW.
/// </summary>
public static class DwTableSchemaResolver
{
    public static List<ResolvedColumn> GetColumns(string tableName, SchemaProposal schema)
    {
        var virtualDim = schema.VirtualDimensions.FirstOrDefault(vd => vd.Name == tableName);
        if (virtualDim != null)
        {
            var columns = new List<ResolvedColumn> { new($"{tableName}Id", "INT") };
            columns.AddRange(virtualDim.ExtraColumns.Select(c => new ResolvedColumn(c.Name, c.Type)));
            return columns;
        }

        var virtualFact = schema.VirtualFacts.FirstOrDefault(vf => vf.Name == tableName);
        if (virtualFact != null)
        {
            var columns = new List<ResolvedColumn> { new($"{tableName}Id", "INT") };
            columns.AddRange(virtualFact.DimensionNames.Select(dim => new ResolvedColumn($"{dim}Id", "INT")));
            return columns;
        }

        var generatedDim = schema.GeneratedDimensions.FirstOrDefault(gd => gd.Name == tableName);
        if (generatedDim != null)
        {
            return generatedDim.Columns.Select(c => new ResolvedColumn(c.Name, c.Type)).ToList();
        }

        var subDim = schema.SubDimensions.FirstOrDefault(sd => sd.Name == tableName);
        if (subDim != null)
        {
            return new List<ResolvedColumn>
            {
                new(subDim.GeneratedPrimaryKey, "INT"),
                new(subDim.SourceColumn, "NVARCHAR(255)")
            };
        }

        if (schema.Dimensions.Contains(tableName))
        {
            var attributes = schema.TableAttributes.GetValueOrDefault(tableName, new List<TableAttribute>());
            var subDimsForThisTable = schema.SubDimensions.Where(sd => sd.ParentDimension == tableName).ToList();
            var subDimSourceColumns = subDimsForThisTable.Select(sd => sd.SourceColumn).ToHashSet(StringComparer.OrdinalIgnoreCase);

            var columns = new List<ResolvedColumn> { new($"{tableName}Id", "INT") };
            columns.AddRange(attributes.Where(a => !subDimSourceColumns.Contains(a.Name)).Select(a => new ResolvedColumn(a.Name, a.Type)));
            columns.AddRange(subDimsForThisTable.Select(sd => new ResolvedColumn(sd.GeneratedPrimaryKey, "INT")));
            return columns;
        }

        if (schema.Facts.Contains(tableName))
        {
            var attributes = schema.TableAttributes.GetValueOrDefault(tableName, new List<TableAttribute>());
            var transformations = schema.FactColumnTransformations.Where(t => t.FactTable == tableName).ToList();
            var factLinks = FactRelationResolver.Resolve(schema).Where(l => l.FactTable == tableName).ToList();

            var excluded = transformations.Select(t => t.OriginalColumn)
                .Concat(factLinks.Select(l => l.NaturalKeyColumn))
                .ToHashSet(StringComparer.OrdinalIgnoreCase);

            var columns = new List<ResolvedColumn> { new($"{tableName}Id", "INT") };
            columns.AddRange(attributes.Where(a => !excluded.Contains(a.Name)).Select(a => new ResolvedColumn(a.Name, a.Type)));
            columns.AddRange(transformations.Select(t => new ResolvedColumn(t.NewColumn, t.NewColumnType)));
            columns.AddRange(factLinks.Select(l => new ResolvedColumn(l.NewFactColumnName, "INT")));
            return columns;
        }

        return new List<ResolvedColumn>();
    }

    /// <summary>Colonnes numériques éligibles à des mesures d'agrégation (exclut les clés techniques).</summary>
    public static List<string> GetNumericMeasureColumns(string factName, SchemaProposal schema)
    {
        var columns = GetColumns(factName, schema);
        var pkColumn = $"{factName}Id";

        return columns
            .Where(c => !c.Name.Equals(pkColumn, StringComparison.OrdinalIgnoreCase))
            .Where(c => !c.Name.EndsWith("Id", StringComparison.OrdinalIgnoreCase) && !c.Name.EndsWith("Key", StringComparison.OrdinalIgnoreCase))
            .Where(c => IsNumericSqlType(c.SqlType))
            .Select(c => c.Name)
            .ToList();
    }

    private static bool IsNumericSqlType(string sqlType)
    {
        var t = sqlType.ToUpperInvariant();
        return t.Contains("INT") || t.Contains("DECIMAL") || t.Contains("NUMERIC") || t.Contains("FLOAT") || t.Contains("REAL");
    }
}