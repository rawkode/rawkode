using System.Text.Json;
using Microsoft.Win32;

namespace Multipass;

internal sealed class MainWindow : Form
{
    private readonly EngineClient engine = new();
    private readonly ComboBox slot = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 100 };
    private readonly Button confirmSlot = new() { Text = "Confirm slot", AutoSize = true };
    private readonly Button useSuggestedSlot = new() { AutoSize = true, Visible = false };
    private readonly Label switchingSetup = new() { AutoSize = true, MaximumSize = new Size(480, 0), Visible = false };
    private readonly CheckBox enabled = new() { Text = "Let the mouse follow the keyboard", AutoSize = true };
    private readonly Label devices = new() { AutoSize = true, Text = "Waiting for device status…" };
    private readonly Label network = new() { AutoSize = true, Text = "Starting engine…" };
    private readonly Label pairing = new() { AutoSize = true, MaximumSize = new Size(480, 0), Text = "Not paired", UseMnemonic = false };
    private readonly Label credentials = new() { AutoSize = true, MaximumSize = new Size(480, 0), ForeColor = Color.Firebrick, UseMnemonic = false, Visible = false };
    private readonly Label handoff = new() { AutoSize = true, MaximumSize = new Size(480, 0), UseMnemonic = false, Visible = false };
    private readonly Label activity = new() { AutoSize = true, MaximumSize = new Size(480, 0) };
    private readonly Label result = new() { AutoSize = true, MaximumSize = new Size(480, 0), ForeColor = SystemColors.GrayText };
    private readonly Button replace = new() { Text = "Pair with a different computer…", AutoSize = true, Visible = false };
    private readonly Label replacementNotice = new() { AutoSize = true, MaximumSize = new Size(480, 0), Text = "Completing a new pairing replaces the current pairing.", Visible = false };
    private readonly Button forget = new() { Text = "Forget pairing", AutoSize = true, Visible = false };
    private readonly FlowLayoutPanel peers = new() { AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false };
    private readonly Label peersPlaceholder = new() { AutoSize = true, MaximumSize = new Size(480, 0), Text = "Open Multipass on the other computer and connect both computers to the same local network. If it still doesn’t appear, check the firewall on both computers." };
    private readonly List<Button> pairButtons = [];
    private readonly NotifyIcon tray;
    private string? nearbyKey;
    private List<(string Id, string Name)> nearby = [];
    private string? pairedPeerId;
    private bool paired;
    private bool replacing;
    private bool credentialsUnavailable;
    private bool slotConfirmed;
    private int localSlot;
    private int? suggestedSlot;
    private string? pairingKey;
    private PairingDialog? pairingDialog;
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
        var slotRow = new FlowLayoutPanel { AutoSize = true, WrapContents = false };
        slotRow.Controls.AddRange([slot, confirmSlot, useSuggestedSlot]);
        layout.Controls.Add(slotRow);
        layout.Controls.Add(new Label { Text = "Choose the Easy-Switch number on the bottom of the mouse that connects to this computer.", AutoSize = true, MaximumSize = new Size(480, 0) });
        layout.Controls.Add(enabled);
        layout.Controls.Add(switchingSetup);
        layout.Controls.Add(devices);
        layout.Controls.Add(network);
        layout.Controls.Add(new Label { Text = "Connect your computers", AutoSize = true, Margin = new Padding(3, 18, 3, 3) });
        layout.Controls.Add(pairing);
        layout.Controls.Add(credentials);
        var pairedRow = new FlowLayoutPanel { AutoSize = true, WrapContents = false };
        pairedRow.Controls.AddRange([replace, forget]);
        layout.Controls.Add(pairedRow);
        layout.Controls.Add(replacementNotice);
        peers.Controls.Add(peersPlaceholder);
        layout.Controls.Add(peers);
        layout.Controls.Add(new Label { Text = "Latest activity", AutoSize = true, Margin = new Padding(3, 18, 3, 3) });
        layout.Controls.Add(handoff);
        layout.Controls.Add(activity);
        layout.Controls.Add(result);
        layout.Controls.Add(new Label { Text = "Closing this window keeps Multipass running in the system tray.", AutoSize = true, MaximumSize = new Size(480, 0), Margin = new Padding(3, 18, 3, 3) });
        Controls.Add(layout);

        var menu = new ContextMenuStrip();
        menu.Items.Add("Open Multipass", null, (_, _) => ShowWindow());
        menu.Items.Add("Quit Multipass", null, async (_, _) => await QuitAsync());
        tray = new NotifyIcon { Icon = SystemIcons.Application, Text = "Multipass", ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += (_, _) => ShowWindow();
        slot.SelectedIndexChanged += (_, _) =>
        {
            if (!rendering) SetActions(engineAvailable);
        };
        confirmSlot.Click += async (_, _) =>
        {
            if (engineAvailable && slot.SelectedIndex >= 0)
                await engine.SendAsync("set_slot", "slot", slot.SelectedIndex + 1);
        };
        useSuggestedSlot.Click += async (_, _) =>
        {
            if (engineAvailable && suggestedSlot is int suggested)
            {
                slot.SelectedIndex = suggested - 1;
                await engine.SendAsync("set_slot", "slot", suggested);
            }
        };
        enabled.CheckedChanged += async (_, _) =>
        {
            if (!rendering && engineAvailable) await engine.SendAsync("set_enabled", "enabled", enabled.Checked);
        };
        replace.Click += (_, _) =>
        {
            replacing = !replacing;
            RenderPeers();
            SetActions(engineAvailable);
        };
        forget.Click += async (_, _) =>
        {
            if (engineAvailable && !credentialsUnavailable && MessageBox.Show(this,
                "You’ll need to pair these computers again before they can switch the mouse.",
                "Forget this pairing?", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning,
                MessageBoxDefaultButton.Button2) == DialogResult.OK)
                await engine.SendAsync("unpair");
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
        slot.Enabled = confirmSlot.Enabled = useSuggestedSlot.Enabled = available;
        confirmSlot.Visible = !slotConfirmed || slot.SelectedIndex + 1 != localSlot;
        confirmSlot.Text = slotConfirmed ? "Save slot" : "Confirm slot";
        useSuggestedSlot.Visible = available && !slotConfirmed && suggestedSlot.HasValue;
        useSuggestedSlot.Text = $"Use detected slot {suggestedSlot}";
        enabled.Enabled = available && (enabled.Checked || (paired && slotConfirmed));
        switchingSetup.Visible = available && (!paired || !slotConfirmed);
        switchingSetup.Text = paired ? "Confirm the mouse slot to turn on switching."
            : slotConfirmed ? "Pair another computer to turn on switching."
            : "Confirm the mouse slot and pair another computer to turn on switching.";
        replace.Enabled = forget.Enabled = available && !credentialsUnavailable;
        replace.Visible = forget.Visible = paired && pairingKey is null;
        replace.Text = replacing ? "Cancel" : "Pair with a different computer…";
        replacementNotice.Visible = available && paired && replacing && pairingKey is null;
        peers.Visible = available && !credentialsUnavailable && (!paired || replacing) && pairingKey is null;
        foreach (var button in pairButtons) button.Enabled = available && !credentialsUnavailable;
    }
    private void Fail(string message)
    {
        engine.Fault(message);
        engineAvailable = false;
        RenderPairing(null);
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
    private async Task DecideAsync(bool accept)
    {
        if (engineAvailable && !quitting) await engine.SendAsync("confirm_pairing", "accept", accept);
    }
    private void ReadPeers(JsonElement peersElement)
    {
        if (peersElement.ValueKind != JsonValueKind.Array) throw new FormatException("Invalid nearby list");
        nearby = [];
        foreach (var peer in peersElement.EnumerateArray())
        {
            var id = peer.GetProperty("id").GetString() ?? throw new FormatException("Invalid peer");
            var name = peer.GetProperty("name").GetString() ?? throw new FormatException("Invalid peer");
            nearby.Add((id, name));
        }
    }

    private void RenderPeers()
    {
        var entries = nearby.Where(entry => entry.Id != pairedPeerId).ToArray();
        var key = $"{replacing}\n" + string.Join("\n", entries.Select(entry => entry.Id + "\t" + entry.Name));
        if (key == nearbyKey) return;
        nearbyKey = key;
        peers.SuspendLayout();
        foreach (Control control in peers.Controls.Cast<Control>().ToArray())
            if (control != peersPlaceholder) control.Dispose();
        peers.Controls.Clear();
        pairButtons.Clear();
        if (entries.Length == 0) peers.Controls.Add(peersPlaceholder);
        foreach (var (id, name) in entries)
        {
            var row = new FlowLayoutPanel { AutoSize = true, WrapContents = false };
            var button = new Button { Text = replacing ? "Replace pairing…" : "Pair…", AutoSize = true, Enabled = engineAvailable };
            button.Click += async (_, _) =>
            {
                if (engineAvailable && !credentialsUnavailable && (!paired || replacing))
                    await engine.SendAsync("pair", ("peer", id), ("replace", replacing));
            };
            row.Controls.Add(new Label { Text = name, AutoSize = true, UseMnemonic = false, MaximumSize = new Size(340, 0), Margin = new Padding(3, 8, 12, 3) });
            row.Controls.Add(button);
            pairButtons.Add(button);
            peers.Controls.Add(row);
        }
        peers.ResumeLayout();
    }
    private void RenderPairing(JsonElement? value)
    {
        string? peerName = null, code = null;
        var incoming = false;
        var locallyConfirmed = false;
        if (value is { ValueKind: JsonValueKind.Object } element)
        {
            peerName = element.GetProperty("peer_name").GetString() ?? throw new FormatException("Invalid pairing");
            incoming = element.GetProperty("incoming").GetBoolean();
            locallyConfirmed = element.GetProperty("locally_confirmed").GetBoolean();
            if (element.TryGetProperty("code", out var codeElement) && codeElement.ValueKind == JsonValueKind.String)
            {
                code = codeElement.GetString();
                if (code is null || !code.All(char.IsAsciiDigit)) throw new FormatException("Invalid pairing code");
            }
        }
        var key = peerName is null ? null : $"{peerName}\u0000{code}\u0000{incoming}\u0000{locallyConfirmed}";
        if (key == pairingKey) return;
        pairingKey = key;
        if (pairingDialog is not null)
        {
            var previous = pairingDialog;
            pairingDialog = null;
            previous.Settle();
            previous.Dispose();
        }
        if (peerName is null) return;
        pairingDialog = new PairingDialog(peerName, code, incoming, locallyConfirmed, paired,
            !credentialsUnavailable, accept => _ = DecideAsync(accept));
        if (incoming) ShowWindow();
        pairingDialog.Show(this);
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
                        var currentSlot = state.GetProperty("local_slot").GetInt32();
                        if (currentSlot is < 1 or > 3) throw new FormatException("Invalid slot");
                        var currentConfirmed = state.GetProperty("slot_confirmed").GetBoolean();
                        if (currentSlot != localSlot || (currentConfirmed && !slotConfirmed) || slot.SelectedIndex < 0)
                            slot.SelectedIndex = currentSlot - 1;
                        localSlot = currentSlot;
                        slotConfirmed = currentConfirmed;
                        var suggested = state.GetProperty("suggested_slot");
                        suggestedSlot = suggested.ValueKind == JsonValueKind.Null ? null : suggested.GetInt32();
                        if (suggestedSlot is < 1 or > 3) throw new FormatException("Invalid suggested slot");
                        enabled.Checked = state.GetProperty("enabled").GetBoolean();
                        devices.Text = $"Keyboard: {Device(state, "keyboard_present")}    Mouse: {Device(state, "mouse_present")}";
                        var currentlyPaired = state.GetProperty("paired").GetBoolean();
                        var pairedPeer = state.GetProperty("paired_peer");
                        var currentPeerId = pairedPeer.ValueKind == JsonValueKind.Null ? null : pairedPeer.GetProperty("id").GetString();
                        var currentPeerName = pairedPeer.ValueKind == JsonValueKind.Null ? null : pairedPeer.GetProperty("name").GetString();
                        if (paired != currentlyPaired || pairedPeerId != currentPeerId) replacing = false;
                        paired = currentlyPaired;
                        pairedPeerId = currentPeerId;
                        credentials.Text = state.TryGetProperty("credential_error", out var error) &&
                            error.ValueKind != JsonValueKind.Null ? error.GetString() : null;
                        credentialsUnavailable = !string.IsNullOrEmpty(credentials.Text);
                        credentials.Visible = credentialsUnavailable;
                        ReadPeers(state.GetProperty("nearby"));
                        pairing.Text = currentPeerName is not null
                            ? $"Paired with {currentPeerName}"
                            : paired ? "Paired computer unknown" : "Not paired — choose a nearby computer.";
                        if (pairedPeerId is not null && !nearby.Any(peer => peer.Id == pairedPeerId))
                            pairing.Text += $"\nOpen Multipass on {currentPeerName} and connect both computers to the same local network.";
                        network.Text = $"{state.GetProperty("node_name").GetString()} · {state.GetProperty("network_status").GetString()}";
                        RenderPeers();
                        var pairingElement = state.GetProperty("pairing");
                        RenderPairing(pairingElement.ValueKind == JsonValueKind.Null ? null : pairingElement);
                        var latestActivity = state.GetProperty("last_event").GetString();
                        var latestHandoff = state.GetProperty("handoff");
                        string? handoffMessage = null;
                        if (latestHandoff.ValueKind != JsonValueKind.Null)
                        {
                            handoffMessage = latestHandoff.GetProperty("message").GetString();
                            var occurredAt = DateTimeOffset.FromUnixTimeSeconds(latestHandoff.GetProperty("occurred_at").GetInt64());
                            handoff.Text = $"{occurredAt.ToLocalTime():g} · {handoffMessage}";
                        }
                        handoff.Visible = handoffMessage is not null;
                        activity.Text = latestActivity == handoffMessage || latestActivity == credentials.Text
                            ? "" : latestActivity;
                        SetActions(engineAvailable);
                    }
                    finally { rendering = false; }
                    break;
                case "result":
                    var ok = value.GetProperty("ok").GetBoolean();
                    result.ForeColor = ok ? SystemColors.GrayText : Color.Firebrick;
                    result.Text = value.GetProperty("message").GetString();
                    break;
            }
        }
        catch (Exception exception) when (exception is KeyNotFoundException or InvalidOperationException or FormatException or ArgumentOutOfRangeException)
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
        RenderPairing(null);
        tray.Visible = false;
        await engine.DisposeAsync();
        tray.Dispose();
        Close();
    }
}
