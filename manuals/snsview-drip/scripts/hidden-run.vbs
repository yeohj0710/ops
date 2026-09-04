' 창 없이 프로그램 하나를 띄우고 곧바로 빠진다.
'   wscript //B //Nologo hidden-run.vbs "<실행파일>" "<인자1>" "<인자2>" ...
'
' 왜 있나. 작업 스케줄러가 node.exe 를 바로 부르면 5분마다 까만 창이 깜빡인다.
' 260815 에 카톡 수집기가 같은 이유로 걷혔다. 그 꼴을 다시 만들지 않으려고 이걸 거친다.
' 두 번째 인자(0)가 "창 숨김", 세 번째(False)가 "기다리지 않는다" 다.
Option Explicit
Dim sh, i, cmd
Set sh = CreateObject("WScript.Shell")
cmd = ""
For i = 0 To WScript.Arguments.Count - 1
  cmd = cmd & """" & WScript.Arguments(i) & """ "
Next
If Len(cmd) = 0 Then WScript.Quit 2
sh.Run cmd, 0, False
