#!/usr/bin/env bash

# Launch-time inventory from Pi, bundled Little Coder extensions, and
# pi-review-gate. ShellSession is intentionally absent because its local
# execSync backend freezes the foreground UI. ShellSessionCwd and
# ShellSessionReset remain allowed because the policy excludes only the
# blocking command tool.
export LITTLE_CODER_ALLOWED_TOOLS="read,bash,edit,write,grep,find,ls,glob,webfetch,websearch,EvidenceAdd,EvidenceGet,EvidenceList,BrowserNavigate,BrowserClick,BrowserType,BrowserScroll,BrowserExtract,BrowserBack,BrowserHistory,dispatch,ShellStart,ShellList,ShellLog,ShellSend,ShellStop,ShellSessionCwd,ShellSessionReset,ExecuteSubtasks"
