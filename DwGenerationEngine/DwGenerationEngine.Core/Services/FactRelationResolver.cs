using DwGenerationEngine.Core.Models;

namespace DwGenerationEngine.Core.Services;

/// <summary>
/// Résout, à partir des ConfirmedRelations du schéma, la liste des liens fait -> dimension
/// à matérialiser en FK dans le DW. Exclut les relations déjà gérées par FactColumnTransformations
/// (DimTemps) pour éviter les doublons.
/// </summary>
public static class FactRelationResolver
{
   public static List<FactDimensionLink> Resolve(SchemaProposal schema)
{
    var links = new List<FactDimensionLink>();
    var factSet = new HashSet<string>(schema.Facts, StringComparer.OrdinalIgnoreCase);

    var handledByTimeTransform = schema.FactColumnTransformations
        .Select(t => (t.FactTable, t.OriginalColumn))
        .ToHashSet();

    var candidatesByPair = new Dictionary<(string Fact, string Dim), List<(string NaturalKeyColumn, string DimNaturalKeyColumn)>>();

    foreach (var rel in schema.ConfirmedRelations)
    {
        var aIsFact = factSet.Contains(rel.TableA);
        var bIsFact = factSet.Contains(rel.TableB);

        if (!aIsFact && !bIsFact) continue;
        if (aIsFact && bIsFact) continue;

        string factTable, naturalKeyColumn, dimensionTable, dimensionNaturalKeyColumn;

        if (aIsFact)
        {
            factTable = rel.TableA;
            naturalKeyColumn = rel.ColumnA;
            dimensionTable = rel.TableB;
            dimensionNaturalKeyColumn = rel.ColumnB;
        }
        else
        {
            factTable = rel.TableB;
            naturalKeyColumn = rel.ColumnB;
            dimensionTable = rel.TableA;
            dimensionNaturalKeyColumn = rel.ColumnA;
        }

        if (handledByTimeTransform.Contains((factTable, naturalKeyColumn))) continue;
        if (dimensionTable.Contains("DimTemps", StringComparison.OrdinalIgnoreCase)) continue;

        // ✅ NOUVEAU : si la colonne cible a été normalisée dans une sous-dimension
        // (ex: SalesTerritory.SalesTerritoryCountry -> DimSalesTerritoryCountry),
        // la colonne n'existe plus sur la table dimension elle-même. On redirige
        // le lien directement vers la sous-dimension, seule à porter réellement cette donnée.
        var subDim = schema.SubDimensions.FirstOrDefault(sd =>
            sd.ParentDimension.Equals(dimensionTable, StringComparison.OrdinalIgnoreCase) &&
            sd.SourceColumn.Equals(dimensionNaturalKeyColumn, StringComparison.OrdinalIgnoreCase));

        if (subDim != null)
        {
            dimensionTable = subDim.Name;
            // dimensionNaturalKeyColumn reste le même nom (la sous-dimension garde sourceColumn tel quel)
        }

        var pairKey = (factTable, dimensionTable);
        if (!candidatesByPair.TryGetValue(pairKey, out var list))
        {
            list = new List<(string, string)>();
            candidatesByPair[pairKey] = list;
        }
        list.Add((naturalKeyColumn, dimensionNaturalKeyColumn));
    }

    foreach (var ((factTable, dimensionTable), candidates) in candidatesByPair)
    {
        var best = candidates
            .OrderByDescending(c => c.NaturalKeyColumn.EndsWith("Key", StringComparison.OrdinalIgnoreCase)
                                  || c.NaturalKeyColumn.EndsWith("Id", StringComparison.OrdinalIgnoreCase))
            .First();

        links.Add(new FactDimensionLink
        {
            FactTable = factTable,
            NaturalKeyColumn = best.NaturalKeyColumn,
            DimensionTable = dimensionTable,
            DimensionNaturalKeyColumn = best.DimNaturalKeyColumn,
            DimensionSurrogateKeyColumn = GetPrimaryKeyColumnName(dimensionTable, schema),
            NewFactColumnName = $"{dimensionTable}Id",
        });
    }

    return links;
}

    /// <summary>
    /// Détermine le nom de la colonne PK (de substitution) d'une table, selon sa nature :
    /// sous-dimension -> GeneratedPrimaryKey ; dimension générée (DimTemps) -> colonne marquée IsPrimaryKey ;
    /// dimension/fait simple -> convention {NomTable}Id.
    /// </summary>
    public static string GetPrimaryKeyColumnName(string tableName, SchemaProposal schema)
    {
        var subDim = schema.SubDimensions
            .FirstOrDefault(sd => sd.Name.Equals(tableName, StringComparison.OrdinalIgnoreCase));
        if (subDim != null) return subDim.GeneratedPrimaryKey;

        var generatedDim = schema.GeneratedDimensions
            .FirstOrDefault(gd => gd.Name.Equals(tableName, StringComparison.OrdinalIgnoreCase));
        if (generatedDim != null)
        {
            var pkCol = generatedDim.Columns.FirstOrDefault(c => c.IsPrimaryKey);
            if (pkCol != null) return pkCol.Name;
        }

        return $"{tableName}Id";
    }
}