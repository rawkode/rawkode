using System.Text.Json;
using Microsoft.Win32;

namespace Multipass;

internal sealed class MainWindow : Form
{
    private readonly EngineClient engine = new();
    private readonly ComboBox slot = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 100 };
    private readonly CheckBox enabled = new() { Text = "Let the mouse follow my keyboard", AutoSize = true };
    private readonly Label devices = new() { AutoSize = true, Text = "Waiting for device status…" };
    private readonly Label network = new() { AutoSize = true, Text = "Starting engine…" };
    private readonly Label pairing = new() { AutoSize = true, Text = "Not paired" };
    private readonly Label activity = new() { AutoSize = true, MaximumSize = new Size(480, 0) };
    private readonly Label result = new() { AutoSize = true, MaximumSize = new Size(480, 0), ForeColor = SystemColors.GrayText };
    private readonly Button create = new() { Text = "Create pairing code", AutoSize = true };
    private readonly Button join = new() { Text = "Join another computer", AutoSize = true };
    private readonly NotifyIcon tray;
    private bool rendering;
    private bool quitting;
    private bool engineAvailable;

    public MainWindow()
    {
        Text = "Multipass";
        MinimumSize = new Size(540, 470);
        Size = new Size(570, 510);
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.Dpi;
        var layout = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown,
            WrapContents = false, AutoScroll = true, Padding = new Padding(24),
        };
        layout.Controls.Add(new Label { Text = "Multipass", Font = new Font(Font, FontStyle.Bold), AutoSize = true });
        layout.Controls.Add(new Label { Text = "Switch your keyboard. Your mouse follows.", AutoSize = true });
        layout.Controls.Add(new Label { Text = "Mouse Bluetooth slot for this computer", AutoSize = true, Margin = new Padding(3, 18, 3, 3) });
        slot.Items.AddRange(["1", "2", "3"]);
        layout.Controls.Add(slot);
        layout.Controls.Add(enabled);
        layout.Controls.Add(devices);
        layout.Controls.Add(network);
        layout.Controls.Add(pairing);
        var pairingButtons = new FlowLayoutPanel { AutoSize = true, WrapContents = false };
        pairingButtons.Controls.AddRange([create, join]);
        layout.Controls.Add(pairingButtons);
        layout.Controls.Add(new Label { Text = "Latest activity", AutoSize = true, Margin = new Padding(3, 18, 3, 3) });
        layout.Controls.Add(activity);
        layout.Controls.Add(result);
        layout.Controls.Add(new Label { Text = "Closing this window keeps Multipass running in the system tray.", AutoSize = true, MaximumSize = new Size(480, 0), Margin = new Padding(3, 18, 3, 3) });
        Controls.Add(layout);

        var menu = new ContextMenuStrip();
        menu.Items.Add("Open Multipass", null, (_, _) => ShowWindow());
        menu.Items.Add("Quit Multipass", null, async (_, _) => await QuitAsync());
        tray = new NotifyIcon { Icon = SystemIcons.Application, Text = "Multipass", ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += (_, _) => ShowWindow();
        slot.SelectedIndexChanged += async (_, _) =>
        {
            if (!rendering && engineAvailable && slot.SelectedIndex >= 0)
                await engine.SendAsync("set_slot", "slot", slot.SelectedIndex + 1);
        };
        enabled.CheckedChanged += async (_, _) =>
        {
            if (!rendering && engineAvailable) await engine.SendAsync("set_enabled", "enabled", enabled.Checked);
        };
        create.Click += async (_, _) => await engine.SendAsync("create_pairing");
        join.Click += async (_, _) =>
        {
            using var dialog = new JoinDialog();
            if (dialog.ShowDialog(this) == DialogResult.OK)
            {
                var code = dialog.TakeCode();
                await engine.SendAsync("join_pairing", "code", code);
            }
        };
        engine.Received += value => OnUi(() => Receive(value));
        engine.Failed += message => OnUi(() => Fail(message));
        SetActions(false);
        Shown += async (_, _) =>
        {
            engineAvailable = engine.Start();
            if (engineAvailable) await engine.SendAsync("status");
        };
        SystemEvents.PowerModeChanged += PowerChanged;
        FormClosing += (_, args) =>
        {
            if (quitting) return;
            args.Cancel = true;
            if (args.CloseReason == CloseReason.UserClosing) Hide();
            else _ = QuitAsync();
        };
    }

    private void ShowWindow() { Show(); WindowState = FormWindowState.Normal; Activate(); }
    private void OnUi(Action action)
    {
        if (IsDisposed || !IsHandleCreated || quitting) return;
        try { BeginInvoke(action); } catch (InvalidOperationException) { }
    }
    private void SetActions(bool available)
    {
        slot.Enabled = enabled.Enabled = create.Enabled = join.Enabled = available;
    }
    private void Fail(string message)
    {
        engine.Fault(message);
        engineAvailable = false;
        SetActions(false);
        result.ForeColor = Color.Firebrick;
        result.Text = message;
        network.Text = "Engine unavailable";
    }
    private static string Device(JsonElement state, string key)
    {
        var value = state.GetProperty(key);
        return value.ValueKind switch { JsonValueKind.True => "Connected", JsonValueKind.False => "Disconnected", _ => "Unknown" };
    }
    private void Receive(JsonElement value)
    {
        if (engine.HasFailed || quitting) return;
        try
        {
            switch (value.GetProperty("type").GetString())
            {
                case "state":
                    var state = value.GetProperty("state");
                    rendering = true;
                    try
                    {
                        var localSlot = state.GetProperty("local_slot").GetInt32();
                        if (localSlot is < 1 or > 3) throw new FormatException("Invalid slot");
                        slot.SelectedIndex = localSlot - 1;
                        enabled.Checked = state.GetProperty("enabled").GetBoolean();
                        devices.Text = $"Keyboard: {Device(state, "keyboard_present")}    Mouse: {Device(state, "mouse_present")}";
                        pairing.Text = state.GetProperty("paired").GetBoolean() ? "Paired" : "Not paired — create a code or join another computer.";
                        network.Text = $"{state.GetProperty("node_name").GetString()} · {state.GetProperty("network_status").GetString()} · Peers: {state.GetProperty("peers").GetInt32()}";
                        activity.Text = state.GetProperty("last_event").GetString();
                        SetActions(engineAvailable);
                    }
                    finally { rendering = false; }
                    break;
                case "result":
                    var ok = value.GetProperty("ok").GetBoolean();
                    result.ForeColor = ok ? SystemColors.GrayText : Color.Firebrick;
                    result.Text = value.GetProperty("message").GetString();
                    if (ok && value.TryGetProperty("pairing_code", out var code) && code.ValueKind == JsonValueKind.String)
                    {
                        using var dialog = new PairingCodeDialog(code.GetString()!);
                        dialog.ShowDialog(this);
                    }
                    break;
            }
        }
        catch (Exception exception) when (exception is KeyNotFoundException or InvalidOperationException or FormatException)
        {
            Fail("The engine response is incompatible with this app. Reinstall the complete package.");
        }
    }
    private void PowerChanged(object sender, PowerModeChangedEventArgs args)
    {
        if (!engineAvailable || quitting) return;
        if (args.Mode == PowerModes.Suspend) _ = engine.SendAsync("suspend");
        if (args.Mode == PowerModes.Resume) _ = engine.SendAsync("resume");
    }
    private async Task QuitAsync()
    {
        if (quitting) return;
        quitting = true;
        SystemEvents.PowerModeChanged -= PowerChanged;
        SetActions(false);
        tray.Visible = false;
        await engine.DisposeAsync();
        tray.Dispose();
        Close();
    }
}
