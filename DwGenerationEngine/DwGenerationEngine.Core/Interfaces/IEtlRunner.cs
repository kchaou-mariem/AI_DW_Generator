using DwGenerationEngine.Core.Models;

namespace DwGenerationEngine.Core.Interfaces;

public interface IEtlRunner
{
    Task<EtlResult> RunAsync(SchemaProposal schema);
}

public class EtlResult
{
    public bool Success { get; set; }
    public List<EtlTableResult> Tables { get; set; } = new();
    public List<string> Errors { get; set; } = new();
}

public class EtlTableResult
{
    public required string TableName { get; set; }
    public int RowsInserted { get; set; }
    public List<string> Warnings { get; set; } = new();
}