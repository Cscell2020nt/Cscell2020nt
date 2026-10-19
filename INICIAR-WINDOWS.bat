@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
 echo Instale o Node.js 24 pelo site https://nodejs.org e tente novamente.
 pause
 exit /b 1
)
node -e "if (Number(process.versions.node.split('.')[0]) < 24) process.exit(1)"
if errorlevel 1 (
 echo Este aplicativo requer Node.js 24 ou superior.
 pause
 exit /b 1
)
echo Preparando o Minas Cell. Aguarde...
call npm ci --no-fund
if errorlevel 1 (
 echo A instalacao falhou. Confira a conexao e a mensagem acima.
 pause
 exit /b 1
)
echo Abra no navegador o endereco Local mostrado a seguir.
echo Mantenha esta janela aberta enquanto estiver usando o aplicativo.
call npm run dev
pause
