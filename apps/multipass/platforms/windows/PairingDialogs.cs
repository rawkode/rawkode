namespace Multipass;

/// <summary>Shows the six-digit code for the pairing in progress. The engine owns the pairing.</summary>
internal sealed class PairingDialog : Form
{
    private readonly Action<bool> decide;
    private bool settled;

    public PairingDialog(string peerName, string? code, bool incoming, Action<bool> decide)
    {
        this.decide = decide;
        Text = "Pair with another computer";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = MaximizeBox = false;
        ShowInTaskbar = false;
        ClientSize = new Size(480, 230);
        var layout = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(18), FlowDirection = FlowDirection.TopDown, WrapContents = false };
        var buttons = new FlowLayoutPanel { AutoSize = true, WrapContents = false, FlowDirection = FlowDirection.LeftToRight, Margin = new Padding(3, 12, 3, 3) };
        if (code is null)
        {
            layout.Controls.Add(new Label { Text = $"Connecting to “{peerName}”…", AutoSize = true, MaximumSize = new Size(440, 0) });
            var cancel = new Button { Text = "Cancel", AutoSize = true };
            cancel.Click += (_, _) => Answer(false);
            buttons.Controls.Add(cancel);
        }
        else
        {
            var heading = incoming ? $"“{peerName}” wants to pair with this computer." : $"Pairing with “{peerName}”.";
            layout.Controls.Add(new Label { Text = heading, AutoSize = true, MaximumSize = new Size(440, 0), Font = new Font(Font, FontStyle.Bold) });
            layout.Controls.Add(new Label
            {
                Text = Spaced(code), AutoSize = true, Margin = new Padding(3, 10, 3, 10),
                Font = new Font(FontFamily.GenericMonospace, 28, FontStyle.Bold),
            });
            layout.Controls.Add(new Label { Text = $"Confirm only if {peerName} shows the same code. Both computers must confirm.", AutoSize = true, MaximumSize = new Size(440, 0) });
            var decline = new Button { Text = incoming ? "Decline" : "Cancel", AutoSize = true };
            var accept = new Button { Text = incoming ? "Accept" : "Confirm", AutoSize = true };
            decline.Click += (_, _) => Answer(false);
            accept.Click += (_, _) => Answer(true);
            buttons.Controls.AddRange([decline, accept]);
            AcceptButton = accept;
        }
        layout.Controls.Add(buttons);
        Controls.Add(layout);
        FormClosing += (_, _) =>
        {
            // Closing with the title-bar button declines, unless the engine already finished.
            if (!settled) { settled = true; decide(false); }
        };
    }

    private static string Spaced(string code) => code.Length == 6 ? $"{code[..3]} {code[3..]}" : code;

    private void Answer(bool accept)
    {
        if (settled) return;
        settled = true;
        Close();
        decide(accept);
    }

    /// <summary>Close because the engine reported the pairing finished; sends no decision.</summary>
    public void Settle()
    {
        settled = true;
        Close();
    }
}
