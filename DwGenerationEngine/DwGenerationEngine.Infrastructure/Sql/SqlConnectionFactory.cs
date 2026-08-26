using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Configuration;

namespace DwGenerationEngine.Infrastructure.Sql;

public interface ISqlConnectionFactory
{
    Task<SqlConnection> CreateConnectionAsync(string database);
    Task<SqlConnection> CreateMasterConnectionAsync();
}

public class SqlConnectionFactory : ISqlConnectionFactory
{
    private readonly string _server;
    private readonly string _user;
    private readonly string _password;

    public SqlConnectionFactory(IConfiguration configuration)
    {
        _server = configuration["Database:Server"] ?? "localhost";
        _user = configuration["Database:User"] ?? "sa";
        _password = configuration["Database:Password"] ?? throw new InvalidOperationException("Database:Password manquant dans la configuration");
    }

    private string BuildConnectionString(string database)
    {
        var builder = new SqlConnectionStringBuilder
        {
            DataSource = _server,
            InitialCatalog = database,
            UserID = _user,
            Password = _password,
            TrustServerCertificate = true,
            ConnectTimeout = 30,
        };
        return builder.ConnectionString;
    }

    public async Task<SqlConnection> CreateConnectionAsync(string database)
    {
        var connection = new SqlConnection(BuildConnectionString(database));
        await connection.OpenAsync();
        return connection;
    }

    public async Task<SqlConnection> CreateMasterConnectionAsync()
    {
        return await CreateConnectionAsync("master");
    }
}