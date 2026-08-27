using DwGenerationEngine.Core.Models;

namespace DwGenerationEngine.Core.Services;

public class SchemaValidationResult
{
    public bool IsValid => Errors.Count == 0;
    public List<string> Errors { get; set; } = new();
    public List<string> Warnings { get; set; } = new();
}

/// <summary>
/// Vérifie la cohérence interne d'un SchemaProposal avant tout envoi en base,
/// pour échouer tôt avec un message clair plutôt qu'une exception SQL/TOM illisible.
/// </summary>
public static class SchemaValidator
{
    public static SchemaValidationResult Validate(SchemaProposal schema)
    {
        var result = new SchemaValidationResult();

        // --- Champs obligatoires ---
        if (string.IsNullOrWhiteSpace(schema.StagingDatabase))
            result.Errors.Add("stagingDatabase est vide ou manquant.");
        if (string.IsNullOrWhiteSpace(schema.DwDatabase))
            result.Errors.Add("dwDatabase est vide ou manquant.");

        if (schema.Dimensions.Count == 0 && schema.Facts.Count == 0)
        {
            result.Errors.Add("Le schéma ne contient aucune dimension ni aucun fait.");
            return result; // pas la peine d'aller plus loin
        }

        // --- Noms de tables uniques entre catégories ---
        var allNames = new List<(string Name, string Category)>();
        allNames.AddRange(schema.Dimensions.Select(d => (d, "dimensions")));
        allNames.AddRange(schema.Facts.Select(f => (f, "facts")));
        allNames.AddRange(schema.SubDimensions.Select(sd => (sd.Name, "subDimensions")));
        allNames.AddRange(schema.GeneratedDimensions.Select(gd => (gd.Name, "generatedDimensions")));

        var duplicates = allNames
            .GroupBy(n => n.Name, StringComparer.OrdinalIgnoreCase)
            .Where(g => g.Count() > 1);

        foreach (var dup in duplicates)
        {
            var categories = string.Join(", ", dup.Select(d => d.Category).Distinct());
            result.Errors.Add($"Le nom de table '{dup.Key}' apparaît plusieurs fois ({categories}) — chaque table doit être unique.");
        }

        // --- tableAttributes présentes et non vides pour chaque dimension/fait ---
        foreach (var dimName in schema.Dimensions)
        {
            if (!schema.TableAttributes.TryGetValue(dimName, out var attrs) || attrs.Count == 0)
                result.Errors.Add($"Aucun tableAttributes trouvé (ou vide) pour la dimension '{dimName}'.");
        }
        foreach (var factName in schema.Facts)
        {
            if (!schema.TableAttributes.TryGetValue(factName, out var attrs) || attrs.Count == 0)
                result.Errors.Add($"Aucun tableAttributes trouvé (ou vide) pour le fait '{factName}'.");
        }

        // --- SubDimensions : parentDimension doit exister dans Dimensions ---
        foreach (var sd in schema.SubDimensions)
        {
            if (!schema.Dimensions.Contains(sd.ParentDimension, StringComparer.OrdinalIgnoreCase))
                result.Errors.Add($"La sous-dimension '{sd.Name}' référence parentDimension '{sd.ParentDimension}' qui n'existe pas dans dimensions.");

            if (string.IsNullOrWhiteSpace(sd.SourceColumn))
                result.Errors.Add($"La sous-dimension '{sd.Name}' n'a pas de sourceColumn.");
            if (string.IsNullOrWhiteSpace(sd.GeneratedPrimaryKey))
                result.Errors.Add($"La sous-dimension '{sd.Name}' n'a pas de generatedPrimaryKey.");
        }

        // --- GeneratedDimensions : exactement une colonne PK ---
        foreach (var gd in schema.GeneratedDimensions)
        {
            var pkCount = gd.Columns.Count(c => c.IsPrimaryKey);
            if (pkCount != 1)
                result.Errors.Add($"La dimension générée '{gd.Name}' doit avoir exactement une colonne isPrimaryKey=true (trouvé: {pkCount}).");
        }

        // --- FactColumnTransformations : FactTable et ReferencesTable doivent exister ---
        foreach (var t in schema.FactColumnTransformations)
        {
            if (!schema.Facts.Contains(t.FactTable, StringComparer.OrdinalIgnoreCase))
                result.Errors.Add($"factColumnTransformations référence factTable '{t.FactTable}' qui n'existe pas dans facts.");

            var referencesExists = schema.GeneratedDimensions.Any(gd => gd.Name.Equals(t.ReferencesTable, StringComparison.OrdinalIgnoreCase));
            if (!referencesExists)
                result.Errors.Add($"factColumnTransformations référence referencesTable '{t.ReferencesTable}' qui n'existe pas dans generatedDimensions.");
        }

        // --- ConfirmedRelations : avertir (pas bloquer) si une table référencée n'existe pas dans le schéma ---
        var knownTables = new HashSet<string>(allNames.Select(n => n.Name), StringComparer.OrdinalIgnoreCase);
        foreach (var rel in schema.ConfirmedRelations)
        {
            if (!knownTables.Contains(rel.TableA))
                result.Warnings.Add($"confirmedRelations référence tableA '{rel.TableA}' absente du schéma (dimensions/facts/subDimensions/generatedDimensions) — relation ignorée.");
            if (!knownTables.Contains(rel.TableB))
                result.Warnings.Add($"confirmedRelations référence tableB '{rel.TableB}' absente du schéma — relation ignorée.");
        }

        // --- Une dimension/fait ne doit pas être sa propre sous-dimension parente (boucle triviale) ---
        foreach (var sd in schema.SubDimensions)
        {
            if (sd.Name.Equals(sd.ParentDimension, StringComparison.OrdinalIgnoreCase))
                result.Errors.Add($"La sous-dimension '{sd.Name}' ne peut pas être sa propre parentDimension.");
        }

        return result;
    }
}