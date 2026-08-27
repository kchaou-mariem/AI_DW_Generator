namespace DwGenerationEngine.Api.Middleware;

public class ApiKeyMiddleware
{
    private const string ApiKeyHeaderName = "X-Api-Key";
    private readonly RequestDelegate _next;

    public ApiKeyMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task InvokeAsync(HttpContext context, IConfiguration configuration)
    {
        // Laisse passer les endpoints non sensibles sans clé (health check, swagger)
        var path = context.Request.Path.Value ?? "";
        if (path.Contains("/health", StringComparison.OrdinalIgnoreCase) ||
            path.Contains("/swagger", StringComparison.OrdinalIgnoreCase))
        {
            await _next(context);
            return;
        }

        var expectedKey = configuration["ApiSecurity:ApiKey"];

        if (string.IsNullOrEmpty(expectedKey))
        {
            // Pas de clé configurée -> on bloque par sécurité plutôt que de tourner ouvert par erreur
            context.Response.StatusCode = StatusCodes.Status500InternalServerError;
            await context.Response.WriteAsync("ApiSecurity:ApiKey non configurée côté serveur.");
            return;
        }

        if (!context.Request.Headers.TryGetValue(ApiKeyHeaderName, out var providedKey) ||
            providedKey != expectedKey)
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            await context.Response.WriteAsync("Clé API manquante ou invalide.");
            return;
        }

        await _next(context);
    }
}