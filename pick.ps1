
Add-Type -AssemblyName System.windows.forms
$f = New-Object System.Windows.Forms.FolderBrowserDialog
$f.ShowNewFolderButton = $true
$res = $f.ShowDialog()
if ($res -eq 'OK') { Write-Output $f.SelectedPath }
