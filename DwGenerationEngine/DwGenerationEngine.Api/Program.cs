using DwGenerationEngine.Core.Interfaces;
using DwGenerationEngine.Infrastructure.Sql;
using DwGenerationEngine.Infrastructure.Tabular;


var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

builder.Services.AddScoped<ISqlConnectionFactory, SqlConnectionFactory>();
builder.Services.AddScoped<IDdlGenerator, DdlGenerator>(); // ← décommenté
builder.Services.AddScoped<IEtlRunner, EtlRunner>(); // ← ajouter
builder.Services.AddScoped<ITabularModelDeployer, TabularModelDeployer>();


var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseHttpsRedirection();
app.UseAuthorization();
app.MapControllers();

app.Run();
