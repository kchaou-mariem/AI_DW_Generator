using DwGenerationEngine.Core.Interfaces;
using DwGenerationEngine.Core.Models;

namespace DwGenerationEngine.Api.DTOs;

public class PipelineRequestDto
{
    public required SchemaProposal Schema { get; set; }
}

public class PipelineResponseDto
{
    public bool Success { get; set; }
    public string StoppedAtStep { get; set; } = "none";
    public GenerateResponseDto? Ddl { get; set; }
    public EtlResponseDto? Etl { get; set; }
    public TabularDeployResponseDto? Tabular { get; set; }
}