using System.Diagnostics;
using System.Text.Json;

namespace Multipass;

/// <summary>The engine owns credentials, settings, networking, and hardware access.</summary>
internal sealed class EngineClient : IAsyncDisposable
{
    private readonly SemaphoreSlim writer = new(1, 1);
    private readonly string executable;
    private Process? process;
    public EngineClient(string? executable = null) => this.executable = executable ?? Path.Combine(AppContext.BaseDirectory, "multipass-engine.exe");
    private Task? reader;
    private Task? errors;
    private long nextId;
    private int stopped;
    private int faulted;
    public bool HasFailed => Volatile.Read(ref faulted) != 0;
    public event Action<JsonElement>? Received;
    public event Action<string>? Failed;

    public bool Start()
    {
        try
        {
            var start = new ProcessStartInfo(executable)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            start.ArgumentList.Add("--stdio");
            process = Process.Start(start) ?? throw new IOException("Engine did not start.");
            process.StandardInput.NewLine = "\n";
            reader = ReadEventsAsync(process);
            errors = DrainErrorsAsync(process);
            return true;
        }
        catch (Exception exception) when (exception is IOException or System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            Fault("Cannot start multipass-engine.exe. Reinstall the complete Multipass package.");
            return false;
        }
    }

    public async Task<long> SendAsync(string command, string? field = null, object? value = null)
    {
        var id = Interlocked.Increment(ref nextId);
        var payload = new Dictionary<string, object?> { ["id"] = id, ["command"] = command };
        if (field is not null) payload[field] = value;
        var serialized = JsonSerializer.Serialize(payload);
        if (System.Text.Encoding.UTF8.GetByteCount(serialized) + 1 > 8192)
        {
            Fault("The command is too large. Quit and reopen Multipass.");
            return id;
        }
        if (HasFailed) return id;
        await writer.WaitAsync();
        try
        {
            if (process is null || process.HasExited) throw new IOException("Engine is unavailable.");
            await process.StandardInput.WriteLineAsync(serialized);
            await process.StandardInput.FlushAsync();
        }
        catch (Exception exception) when (exception is IOException or InvalidOperationException or ObjectDisposedException)
        {
            if (Volatile.Read(ref stopped) == 0) Fault("Connection to the engine was lost. Quit and reopen Multipass.");
        }
        finally { writer.Release(); }
        return id;
    }

    private async Task ReadEventsAsync(Process child)
    {
        try
        {
            // Read bounded frames: a broken child cannot allocate an unbounded line.
            var buffer = new char[4096];
            var line = new System.Text.StringBuilder();
            int length;
            while ((length = await child.StandardOutput.ReadAsync(buffer.AsMemory())) != 0)
            {
                for (var i = 0; i < length; i++)
                {
                    if (buffer[i] == '\n')
                    {
                        using var document = JsonDocument.Parse(line.ToString());
                        if (document.RootElement.ValueKind != JsonValueKind.Object) throw new JsonException();
                        if (!HasFailed && Volatile.Read(ref stopped) == 0)
                            Received?.Invoke(document.RootElement.Clone());
                        line.Clear();
                    }
                    else
                    {
                        if (line.Length >= 1024 * 1024) throw new JsonException();
                        line.Append(buffer[i]);
                    }
                }
            }
            if (Volatile.Read(ref stopped) == 0) Fault("The engine stopped. Quit and reopen Multipass to reconnect.");
        }
        catch (Exception exception) when (exception is IOException or JsonException or InvalidOperationException or ObjectDisposedException)
        {
            if (Volatile.Read(ref stopped) == 0)
            {
                Fault("The engine returned an invalid response or disconnected. Quit and reopen Multipass.");
            }
        }
    }

    public void Fault(string message)
    {
        if (Volatile.Read(ref stopped) != 0 || Interlocked.Exchange(ref faulted, 1) != 0) return;
        // Closing the anonymous input pipe tells a healthy engine to stop. Kill
        // also covers a child that closed stdout but is still switching devices.
        if (process is not null)
        {
            try { process.StandardInput.Close(); }
            catch (Exception exception) when (exception is IOException or InvalidOperationException or ObjectDisposedException) { }
            try { if (!process.HasExited) process.Kill(); }
            catch (InvalidOperationException) { }
            catch (System.ComponentModel.Win32Exception)
            {
                message = "The engine could not be stopped. Quit Multipass and end multipass-engine in Task Manager.";
            }
        }
        Failed?.Invoke(message);
    }

    private static async Task DrainErrorsAsync(Process child)
    {
        // Diagnostics are deliberately not copied into UI/logs: stdout contains the
        // structured user messages, and no third-party stderr can leak pairing data.
        var buffer = new char[4096];
        try { while (await child.StandardError.ReadAsync(buffer.AsMemory()) != 0) { } }
        catch (Exception exception) when (exception is IOException or ObjectDisposedException) { }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref stopped, 1) != 0) return;
        if (process is not null)
        {
            await SendAsync("shutdown");
            try { process.StandardInput.Close(); }
            catch (Exception exception) when (exception is IOException or ObjectDisposedException) { }
            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                await process.WaitForExitAsync(timeout.Token);
            }
            catch (OperationCanceledException)
            {
                try { process.Kill(); } catch (InvalidOperationException) { }
                await process.WaitForExitAsync();
            }
            if (reader is not null) await reader;
            if (errors is not null) await errors;
            process.Dispose();
        }
        writer.Dispose();
    }
}
