Add-Type -AssemblyName System.Drawing
$fixturePath = Join-Path $PSScriptRoot '..\.data\vision-test.png'
$bitmap = [System.Drawing.Bitmap]::new(1000, 600)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([System.Drawing.Color]::White)
$font = [System.Drawing.Font]::new('Microsoft YaHei', 30)
$graphics.DrawString('今日学习记录 Q7M4', $font, [System.Drawing.Brushes]::Black, 40, 30)
$graphics.DrawString('教育学：完成 20 道题', $font, [System.Drawing.Brushes]::Black, 40, 110)
$graphics.DrawString('错题：3 道；复习：45 分钟', $font, [System.Drawing.Brushes]::Black, 40, 190)
$graphics.FillRectangle([System.Drawing.Brushes]::Blue, 60, 340, 160, 100)
$graphics.FillEllipse([System.Drawing.Brushes]::Red, 370, 330, 120, 120)
$bitmap.Save($fixturePath, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$font.Dispose()
$bitmap.Dispose()
Write-Output $fixturePath
