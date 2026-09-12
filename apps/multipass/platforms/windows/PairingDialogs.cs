namespace Multipass;

internal sealed class JoinDialog : Form
{
    private readonly TextBox code = new() { UseSystemPasswordChar = true, Width = 350, MaxLength = 512 };
    public JoinDialog()
    {
        Text = "Join a computer";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = MaximizeBox = false;
        ClientSize = new Size(410, 150);
        var layout = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(18), FlowDirection = FlowDirection.TopDown };
        layout.Controls.Add(new Label { Text = "Enter the pairing code shown on your other computer.", AutoSize = true });
        layout.Controls.Add(code);
        var submit = new Button { Text = "Join", DialogResult = DialogResult.OK, Enabled = false };
        code.TextChanged += (_, _) => submit.Enabled = !string.IsNullOrWhiteSpace(code.Text);
        layout.Controls.Add(submit);
        Controls.Add(layout);
        AcceptButton = submit;
    }
    public string TakeCode() { var value = code.Text.Trim(); code.Clear(); return value; }
    protected override void Dispose(bool disposing) { if (disposing) code.Clear(); base.Dispose(disposing); }
}

internal sealed class PairingCodeDialog : Form
{
    private readonly TextBox code;
    public PairingCodeDialog(string value)
    {
        Text = "Pair another computer";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = MaximizeBox = false;
        ClientSize = new Size(480, 180);
        var layout = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(18), FlowDirection = FlowDirection.TopDown };
        layout.Controls.Add(new Label { Text = "On the other computer choose Join and enter this code.", AutoSize = true });
        code = new TextBox { Text = value, ReadOnly = true, Width = 430 };
        layout.Controls.Add(code);
        var copy = new Button { Text = "Copy code", AutoSize = true };
        copy.Click += (_, _) =>
        {
            try { Clipboard.SetText(code.Text); copy.Text = "Copied"; }
            catch (System.Runtime.InteropServices.ExternalException) { copy.Text = "Clipboard busy — retry"; }
        };
        layout.Controls.Add(copy);
        layout.Controls.Add(new Label { Text = "Keep this code private. Copying places it on your system clipboard.", AutoSize = true });
        Controls.Add(layout);
    }
    protected override void Dispose(bool disposing) { if (disposing) code.Clear(); base.Dispose(disposing); }
}
