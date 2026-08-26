using DwGenerationEngine.Core.Interfaces;
using DwGenerationEngine.Core.Models;

namespace DwGenerationEngine.Api.DTOs;

public class EtlRequestDto
{
    public required SchemaProposal Schema { get; set; }
}

public class EtlResponseDto
{
    public bool Success { get; set; }
    public List<EtlTableResult> Tables { get; set; } = new();
    public List<string> Errors { get; set; } = new();
}