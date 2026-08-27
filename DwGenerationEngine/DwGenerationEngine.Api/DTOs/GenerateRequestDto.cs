using DwGenerationEngine.Core.Models;

namespace DwGenerationEngine.Api.DTOs;

public class GenerateRequestDto
{
    public required SchemaProposal Schema { get; set; }
}

public class GenerateResponseDto
{
    public bool Success { get; set; }
    public List<string> CreatedTables { get; set; } = new();
    public List<string> DroppedOrphanTables { get; set; } = new(); // ← nouveau
    public List<string> Errors { get; set; } = new();
}