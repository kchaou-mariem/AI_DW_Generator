// using Microsoft.AspNetCore.Mvc;
// using DwGenerationEngine.Api.DTOs;
// using DwGenerationEngine.Core.Interfaces;

// namespace DwGenerationEngine.Api.Controllers;

// [ApiController]
// [Route("api/dw")]
// public class DwController : ControllerBase
// {
//     private readonly IDdlGenerator _ddlGenerator;
//     private readonly ILogger<DwController> _logger;

//     private readonly IEtlRunner _etlRunner; // à ajouter au constructeur

// public DwController(IDdlGenerator ddlGenerator, IEtlRunner etlRunner, ILogger<DwController> logger)
// {
//     _ddlGenerator = ddlGenerator;
//     _etlRunner = etlRunner;
//     _logger = logger;
// }

// [HttpPost("run-etl")]
// public async Task<ActionResult<EtlResponseDto>> RunEtl([FromBody] EtlRequestDto request)
// {
//     _logger.LogInformation("ETL demandé pour la base DW: {DwDatabase}", request.Schema.DwDatabase);

//     try
//     {
//         var result = await _etlRunner.RunAsync(request.Schema);
//         return Ok(new EtlResponseDto
//         {
//             Success = result.Success,
//             Tables = result.Tables,
//             Errors = result.Errors,
//         });
//     }
//     catch (Exception ex)
//     {
//         _logger.LogError(ex, "Erreur lors de l'exécution de l'ETL");
//         return StatusCode(500, new EtlResponseDto { Success = false, Errors = new List<string> { ex.Message } });
//     }
// }

//     [HttpPost("generate-ddl")]
//     public async Task<ActionResult<GenerateResponseDto>> GenerateDdl([FromBody] GenerateRequestDto request)
//     {
//         _logger.LogInformation("Génération DDL demandée pour la base DW: {DwDatabase}", request.Schema.DwDatabase);

//         try
//         {
//             var result = await _ddlGenerator.GenerateAsync(request.Schema);

//             return Ok(new GenerateResponseDto
//             {
//                 Success = result.Success,
//                 CreatedTables = result.CreatedTables,
//                 Errors = result.Errors,
//             });
//         }
//         catch (Exception ex)
//         {
//             _logger.LogError(ex, "Erreur lors de la génération DDL");
//             return StatusCode(500, new GenerateResponseDto
//             {
//                 Success = false,
//                 Errors = new List<string> { ex.Message },
//             });
//         }
//     }

//     [HttpGet("health")]
//     public IActionResult Health() => Ok(new { status = "ok" });

//     private readonly ITabularModelDeployer _tabularDeployer; // à ajouter au constructeur

// public DwController(IDdlGenerator ddlGenerator, IEtlRunner etlRunner, ITabularModelDeployer tabularDeployer, ILogger<DwController> logger)
// {
//     _ddlGenerator = ddlGenerator;
//     _etlRunner = etlRunner;
//     _tabularDeployer = tabularDeployer;
//     _logger = logger;
// }

// [HttpPost("deploy-tabular")]
// public async Task<ActionResult<TabularDeployResponseDto>> DeployTabular([FromBody] TabularDeployRequestDto request)
// {
//     _logger.LogInformation("Déploiement Tabular demandé pour: {DwDatabase}", request.Schema.DwDatabase);

//     try
//     {
//         var result = await _tabularDeployer.DeployAsync(request.Schema);
//         return Ok(new TabularDeployResponseDto
//         {
//             Success = result.Success,
//             CreatedTables = result.CreatedTables,
//             CreatedRelationships = result.CreatedRelationships,
//             CreatedMeasures = result.CreatedMeasures,
//             Errors = result.Errors,
//         });
//     }
//     catch (Exception ex)
//     {
//         _logger.LogError(ex, "Erreur lors du déploiement Tabular");
//         return StatusCode(500, new TabularDeployResponseDto { Success = false, Errors = new List<string> { ex.Message } });
//     }
// }
// }

using Microsoft.AspNetCore.Mvc;
using DwGenerationEngine.Api.DTOs;
using DwGenerationEngine.Core.Interfaces;
using DwGenerationEngine.Core.Services;
namespace DwGenerationEngine.Api.Controllers;

[ApiController]
[Route("api/dw")]
public class DwController : ControllerBase
{
    private readonly IDdlGenerator _ddlGenerator;
    private readonly IEtlRunner _etlRunner;
    private readonly ITabularModelDeployer _tabularDeployer;
    private readonly ILogger<DwController> _logger;
    private readonly IPipelineOrchestrator _pipelineOrchestrator; 

 public DwController(
    IDdlGenerator ddlGenerator,
    IEtlRunner etlRunner,
    ITabularModelDeployer tabularDeployer,
    IPipelineOrchestrator pipelineOrchestrator,
    ILogger<DwController> logger)
{
    _ddlGenerator = ddlGenerator;
    _etlRunner = etlRunner;
    _tabularDeployer = tabularDeployer;
    _pipelineOrchestrator = pipelineOrchestrator;
    _logger = logger;
}

    [HttpPost("run-etl")]
    public async Task<ActionResult<EtlResponseDto>> RunEtl([FromBody] EtlRequestDto request)
    {
        var validation = SchemaValidator.Validate(request.Schema);
    if (!validation.IsValid)
    {
        _logger.LogWarning("Schéma invalide pour generate-ddl: {Errors}", string.Join(" | ", validation.Errors));
        return BadRequest(new GenerateResponseDto
        {
            Success = false,
            Errors = validation.Errors,
        });
    }
    _logger.LogInformation("ETL demandé pour la base DW: {DwDatabase}", request.Schema.DwDatabase);

        try
        {
            var result = await _etlRunner.RunAsync(request.Schema);
            return Ok(new EtlResponseDto
            {
                Success = result.Success,
                Tables = result.Tables,
                Errors = result.Errors,
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Erreur lors de l'exécution de l'ETL");
            return StatusCode(500, new EtlResponseDto { Success = false, Errors = new List<string> { ex.Message } });
        }
    }

    [HttpPost("generate-ddl")]
    public async Task<ActionResult<GenerateResponseDto>> GenerateDdl([FromBody] GenerateRequestDto request)
    {
       var validation = SchemaValidator.Validate(request.Schema);
    if (!validation.IsValid)
    {
        _logger.LogWarning("Schéma invalide pour generate-ddl: {Errors}", string.Join(" | ", validation.Errors));
        return BadRequest(new GenerateResponseDto
        {
            Success = false,
            Errors = validation.Errors,
        });
    }
        _logger.LogInformation("Génération DDL demandée pour la base DW: {DwDatabase}", request.Schema.DwDatabase);

        try
        {
            var result = await _ddlGenerator.GenerateAsync(request.Schema);

            return Ok(new GenerateResponseDto
            {
                Success = result.Success,
                CreatedTables = result.CreatedTables,
                Errors = result.Errors,
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Erreur lors de la génération DDL");
            return StatusCode(500, new GenerateResponseDto
            {
                Success = false,
                Errors = new List<string> { ex.Message },
            });
        }
    }

    [HttpPost("deploy-tabular")]
    public async Task<ActionResult<TabularDeployResponseDto>> DeployTabular([FromBody] TabularDeployRequestDto request)
    {
        var validation = SchemaValidator.Validate(request.Schema);
    if (!validation.IsValid)
    {
        _logger.LogWarning("Schéma invalide pour generate-ddl: {Errors}", string.Join(" | ", validation.Errors));
        return BadRequest(new GenerateResponseDto
        {
            Success = false,
            Errors = validation.Errors,
        });
    }
        _logger.LogInformation("Déploiement Tabular demandé pour: {DwDatabase}", request.Schema.DwDatabase);

        try
        {
            var result = await _tabularDeployer.DeployAsync(request.Schema);
            return Ok(new TabularDeployResponseDto
            {
                Success = result.Success,
                CreatedTables = result.CreatedTables,
                CreatedRelationships = result.CreatedRelationships,
                CreatedMeasures = result.CreatedMeasures,
                Errors = result.Errors,
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Erreur lors du déploiement Tabular");
            return StatusCode(500, new TabularDeployResponseDto { Success = false, Errors = new List<string> { ex.Message } });
        }
    }

    [HttpGet("health")]
    public IActionResult Health() => Ok(new { status = "ok" });

    ////////////////////

    [HttpPost("build-full-pipeline")]
public async Task<ActionResult<PipelineResponseDto>> BuildFullPipeline([FromBody] PipelineRequestDto request)
{
    var validation = SchemaValidator.Validate(request.Schema);
    if (!validation.IsValid)
    {
        _logger.LogWarning("Schéma invalide pour generate-ddl: {Errors}", string.Join(" | ", validation.Errors));
        return BadRequest(new GenerateResponseDto
        {
            Success = false,
            Errors = validation.Errors,
        });
    }

    _logger.LogInformation("Génération DDL demandée pour la base DW: {DwDatabase}", request.Schema.DwDatabase);

    try
    {
        var result = await _pipelineOrchestrator.RunFullPipelineAsync(request.Schema);

        return Ok(new PipelineResponseDto
        {
            Success = result.Success,
            StoppedAtStep = result.StoppedAtStep,
            Ddl = result.DdlResult == null ? null : new GenerateResponseDto
            {
                Success = result.DdlResult.Success,
                CreatedTables = result.DdlResult.CreatedTables,
                Errors = result.DdlResult.Errors,
            },
            Etl = result.EtlResult == null ? null : new EtlResponseDto
            {
                Success = result.EtlResult.Success,
                Tables = result.EtlResult.Tables,
                Errors = result.EtlResult.Errors,
            },
            Tabular = result.TabularResult == null ? null : new TabularDeployResponseDto
            {
                Success = result.TabularResult.Success,
                CreatedTables = result.TabularResult.CreatedTables,
                CreatedRelationships = result.TabularResult.CreatedRelationships,
                CreatedMeasures = result.TabularResult.CreatedMeasures,
                Errors = result.TabularResult.Errors,
            },
        });
    }
    catch (Exception ex)
    {
        _logger.LogError(ex, "Erreur inattendue dans le pipeline complet");
        return StatusCode(500, new PipelineResponseDto { Success = false, StoppedAtStep = "unexpected_error" });
    }
}
}