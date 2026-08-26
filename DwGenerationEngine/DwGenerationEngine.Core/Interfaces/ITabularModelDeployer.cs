using DwGenerationEngine.Core.Models;

namespace DwGenerationEngine.Core.Interfaces;

public interface ITabularModelDeployer
{
    Task<TabularDeployResult> DeployAsync(SchemaProposal schema);
}

public class TabularDeployResult
{
    public bool Success { get; set; }
    public List<string> CreatedTables { get; set; } = new();
    public List<string> CreatedRelationships { get; set; } = new();
    public List<string> CreatedMeasures { get; set; } = new();
    public List<string> Errors { get; set; } = new();
}