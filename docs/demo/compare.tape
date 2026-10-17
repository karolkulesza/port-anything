# The README demo: GNU sort against uutils sort, zero config, in the Linux dev container
# (there, `gnusort` is GNU sort and `coreutils` the uutils multicall binary). Record it with
# docs/demo/record.sh while nothing else is running: the GIF plays in real time.
Output docs/demo/compare.gif

Set Shell bash
Set FontSize 14
Set Width 1000
Set Height 920
Set Padding 20
Set Framerate 20
Set TypingSpeed 45ms
Set WindowBar Colorful

Hide
Type "export PS1='$ ' && alias port-anything='node /repo/packages/cli/dist/bin.js' && cd $(mktemp -d) && clear"
Enter
Sleep 500ms
Show

Type "port-anything compare gnusort 'coreutils sort'"
Sleep 600ms
Enter
# The run takes 20–40 s on a quiet machine; wait for the prompt to come back, then leave the result on screen.
Wait@120s /\$\s*$/
Sleep 4s
