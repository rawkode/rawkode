using System.Diagnostics;
using System.Text.Json;
using Multipass;

internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        if (args.Contains("--stdio"))
        {
            var scenario = Environment.GetEnvironmentVariable("MULTIPASS_TRANSPORT_TEST_SCENARIO");
            Console.WriteLine(JsonSerializer.Serialize(new { type = "started", pid = Environment.ProcessId }));
            await Console.Out.FlushAsync();
            if (scenario == "malformed") { Console.WriteLine("not JSON"); await Console.Out.FlushAsync(); }
            else if (scenario == "schema") { Console.WriteLine("{\"type\":\"state\",\"state\":{}}"); await Console.Out.FlushAsync(); }
            await Task.Delay(TimeSpan.FromSeconds(30));
            return 0;
        }
        foreach (var scenario in new[] { "malformed", "schema", "oversize" })
        {
            Environment.SetEnvironmentVariable("MULTIPASS_TRANSPORT_TEST_SCENARIO", scenario);
            await using var client = new EngineClient(Environment.ProcessPath);
            var started = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
            var failed = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            client.Received += value =>
            {
                if (value.GetProperty("type").GetString() == "started") started.TrySetResult(value.GetProperty("pid").GetInt32());
                else if (scenario == "schema") client.Fault("Invalid schema");
            };
            client.Failed += message => failed.TrySetResult(message);
            if (!client.Start()) throw new Exception("Fixture engine could not start");
            var pid = await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
            if (scenario == "oversize") await client.SendAsync("join_pairing", "code", new string('x', 8192));
            await failed.Task.WaitAsync(TimeSpan.FromSeconds(5));
            if (!client.HasFailed) throw new Exception("Transport did not remain faulted");
            try
            {
                using var child = Process.GetProcessById(pid);
                await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
            }
            catch (ArgumentException) { /* Already reaped. */ }
            await client.SendAsync("status"); // Faulted clients discard follow-up commands.
            Console.WriteLine($"PASS {scenario}: transport failed closed and stopped owned engine");
        }
        Environment.SetEnvironmentVariable("MULTIPASS_TRANSPORT_TEST_SCENARIO", null);
        return 0;
    }
}
