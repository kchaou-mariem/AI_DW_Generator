namespace DwGenerationEngine.Core.Models;

public class SchemaProposal
{
    public required string StagingDatabase { get; set; }
    public required string DwDatabase { get; set; }
    public List<string> Dimensions { get; set; } = new();
    public List<string> Facts { get; set; } = new();
    public List<ConfirmedRelation> ConfirmedRelations { get; set; } = new();
    public List<SubDimension> SubDimensions { get; set; } = new();
    public Dictionary<string, List<TableAttribute>> TableAttributes { get; set; } = new();
    public List<GeneratedDimension> GeneratedDimensions { get; set; } = new();
    public List<FactColumnTransformation> FactColumnTransformations { get; set; } = new();
    public List<VirtualFact> VirtualFacts { get; set; } = new();
}

public class ConfirmedRelation
{
    public required string TableA { get; set; }
    public required string ColumnA { get; set; }
    public required string TableB { get; set; }
    public required string ColumnB { get; set; }
    public string? Reason { get; set; }
}

public class SubDimension
{
    public required string Name { get; set; }
    public required string ParentDimension { get; set; }
    public required string SourceColumn { get; set; }
    public required string GeneratedPrimaryKey { get; set; }
}

public class TableAttribute
{
    public required string Name { get; set; }
    public required string Type { get; set; }
}

public class GeneratedDimension
{
    public required string Name { get; set; }
    public List<GeneratedColumn> Columns { get; set; } = new();
}

public class GeneratedColumn
{
    public required string Name { get; set; }
    public required string Type { get; set; }
    public bool IsPrimaryKey { get; set; }
}

public class FactColumnTransformation
{
    public required string FactTable { get; set; }
    public required string OriginalColumn { get; set; }
    public required string NewColumn { get; set; }
    public required string NewColumnType { get; set; }
    public required string ReferencesTable { get; set; }
    public required string ReferencesColumn { get; set; }
}
public class VirtualFact
{
    public required string Name { get; set; }
    public List<string> DimensionNames { get; set; } = new();
}