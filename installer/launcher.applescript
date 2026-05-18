-- 拾字 · Voicetype Studio 启动器
-- 双击：检测安装 → 后台跑 server → 自动开浏览器

on run
    set projectPath to (POSIX path of (path to home folder)) & "Projects/shizi"
    set venvPython to projectPath & "/.venv/bin/python"

    -- 1. 检查项目是否安装到位
    set installCheck to do shell script "test -f " & quoted form of (projectPath & "/server.py") & " && test -x " & quoted form of venvPython & " && echo OK || echo MISSING"
    if installCheck is "MISSING" then
        set userChoice to display dialog ¬
            "拾字尚未安装。" & return & return & ¬
            "需要先在终端跑一次 setup.sh 装好依赖（约 3-5 分钟）。" & return & return & ¬
            "把项目克隆到 ~/Projects/shizi/，然后双击「首次安装.command」。" ¬
            buttons {"打开 GitHub 下载", "取消"} default button "打开 GitHub 下载"
        if button returned of userChoice is "打开 GitHub 下载" then
            do shell script "open https://github.com/gejiangren/shizi"
        end if
        return
    end if

    -- 2. 检测是否已经在跑（避免重复启动）
    set runningCheck to do shell script "lsof -ti:7860 > /dev/null 2>&1 && echo RUNNING || echo STOPPED"
    if runningCheck is "RUNNING" then
        do shell script "open http://127.0.0.1:7860"
        display notification "已在运行，打开浏览器" with title "拾字"
        return
    end if

    -- 3. 后台启动 server（nohup + disown，关掉所有终端也不影响）
    do shell script ¬
        "cd " & quoted form of projectPath & " && " & ¬
        "nohup " & quoted form of venvPython & " server.py > /tmp/shizi.log 2>&1 & " & ¬
        "echo $! > /tmp/shizi.pid"

    -- 4. 等服务起来（最多 30 秒）
    set ready to false
    repeat 60 times
        try
            do shell script "curl -s -o /dev/null --max-time 1 http://127.0.0.1:7860/ && echo OK"
            set ready to true
            exit repeat
        on error
            delay 0.5
        end try
    end repeat

    if ready then
        do shell script "open http://127.0.0.1:7860"
        display notification "已启动 · http://127.0.0.1:7860" with title "拾字 Voicetype Studio"
    else
        display dialog "启动超时 30 秒未就绪。" & return & return & ¬
            "请打开 终端 跑：" & return & "cat /tmp/shizi.log" & return & "查看日志告诉开发者。" ¬
            buttons {"看日志", "取消"} default button "看日志"
        if button returned of result is "看日志" then
            do shell script "open -e /tmp/shizi.log"
        end if
    end if
end run
