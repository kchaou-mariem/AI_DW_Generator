using DwGenerationEngine.Core.Models;

namespace DwGenerationEngine.Core.Interfaces;

public interface IDdlGenerator
{
    /// <summary>
    /// Génère et exécute les scripts CREATE TABLE pour toutes les dimensions,
    /// sous-dimensions et faits du schéma, dans la base DW cible.
    /// </summary>
    Task<DdlGenerationResult> GenerateAsync(SchemaProposal schema);
}

public class DdlGenerationResult
{
    public bool Success { get; set; }
    public List<string> CreatedTables { get; set; } = new();
    public List<string> Errors { get; set; } = new();
    public List<string> ExecutedScripts { get; set; } = new();
}