using Microsoft.Extensions.Logging;
using DwGenerationEngine.Core.Interfaces;
using DwGenerationEngine.Core.Models;

namespace DwGenerationEngine.Infrastructure.Orchestration;

public class PipelineOrchestrator : IPipelineOrchestrator
{
    private readonly IDdlGenerator _ddlGenerator;
    private readonly IEtlRunner _etlRunner;
    private readonly ITabularModelDeployer _tabularDeployer;
    private readonly ILogger<PipelineOrchestrator> _logger;

    public PipelineOrchestrator(
        IDdlGenerator ddlGenerator,
        IEtlRunner etlRunner,
        ITabularModelDeployer tabularDeployer,
        ILogger<PipelineOrchestrator> logger)
    {
        _ddlGenerator = ddlGenerator;
        _etlRunner = etlRunner;
        _tabularDeployer = tabularDeployer;
        _logger = logger;
    }

    public async Task<PipelineResult> RunFullPipelineAsync(SchemaProposal schema)
    {
        var result = new PipelineResult();

        _logger.LogInformation("Pipeline complet démarré pour {DwDatabase}", schema.DwDatabase);

        // Étape 1 — DDL
        var ddlResult = await _ddlGenerator.GenerateAsync(schema);
        result.DdlResult = ddlResult;

        if (!ddlResult.Success)
        {
            result.Success = false;
            result.StoppedAtStep = "ddl";
            _logger.LogWarning("Pipeline arrêté à l'étape DDL pour {DwDatabase}", schema.DwDatabase);
            return result;
        }

        // Étape 2 — ETL
        var etlResult = await _etlRunner.RunAsync(schema);
        result.EtlResult = etlResult;

        if (!etlResult.Success)
        {
            result.Success = false;
            result.StoppedAtStep = "etl";
            _logger.LogWarning("Pipeline arrêté à l'étape ETL pour {DwDatabase} (DDL avait réussi)", schema.DwDatabase);
            return result;
        }

        // Étape 3 — Déploiement Tabular
        var tabularResult = await _tabularDeployer.DeployAsync(schema);
        result.TabularResult = tabularResult;

        if (!tabularResult.Success)
        {
            result.Success = false;
            result.StoppedAtStep = "tabular";
            _logger.LogWarning("Pipeline arrêté à l'étape Tabular pour {DwDatabase} (DDL et ETL avaient réussi)", schema.DwDatabase);
            return result;
        }

        result.Success = true;
        result.StoppedAtStep = "none";
        _logger.LogInformation("Pipeline complet réussi pour {DwDatabase}", schema.DwDatabase);
        return result;
    }
}