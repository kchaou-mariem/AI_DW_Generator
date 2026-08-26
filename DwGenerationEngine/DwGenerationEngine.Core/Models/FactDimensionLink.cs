namespace DwGenerationEngine.Core.Models;

/// <summary>
/// Représente le lien entre une table de faits et une dimension, dérivé de ConfirmedRelations.
/// Utilisé à la fois par le générateur DDL (pour créer la FK) et, plus tard, par l'ETL
/// (pour savoir comment faire le lookup clé naturelle -> clé de substitution).
/// </summary>
public class FactDimensionLink
{
    public required string FactTable { get; set; }
    public required string NaturalKeyColumn { get; set; }         // colonne staging dans le fait (ex: ProductKey)
    public required string DimensionTable { get; set; }
    public required string DimensionNaturalKeyColumn { get; set; } // colonne staging dans la dimension (ex: ProductKey)
    public required string DimensionSurrogateKeyColumn { get; set; } // PK réelle générée dans le DW (ex: ProductsId)
    public required string NewFactColumnName { get; set; }        // nom de la colonne FK créée dans le fait (ex: ProductsId)
}