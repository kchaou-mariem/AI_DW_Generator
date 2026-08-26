using DwGenerationEngine.Core.Models;

namespace DwGenerationEngine.Core.Interfaces;

public interface IPipelineOrchestrator
{
    Task<PipelineResult> RunFullPipelineAsync(SchemaProposal schema);
}

public class PipelineResult
{
    public bool Success { get; set; }
    public string StoppedAtStep { get; set; } = "none"; // "ddl", "etl", "tabular", ou "none" si tout a réussi
    public DdlGenerationResult? DdlResult { get; set; }
    public EtlResult? EtlResult { get; set; }
    public TabularDeployResult? TabularResult { get; set; }
}