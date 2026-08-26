using DwGenerationEngine.Core.Interfaces;
using DwGenerationEngine.Core.Models;

namespace DwGenerationEngine.Api.DTOs;

public class TabularDeployRequestDto
{
    public required SchemaProposal Schema { get; set; }
}

public class TabularDeployResponseDto
{
    public bool Success { get; set; }
    public List<string> CreatedTables { get; set; } = new();
    public List<string> CreatedRelationships { get; set; } = new();
    public List<string> CreatedMeasures { get; set; } = new();
    public List<string> Errors { get; set; } = new();
}