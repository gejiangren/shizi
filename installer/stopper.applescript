-- 拾字 · 停止器
-- 双击：杀掉跑在 7860 端口的 server 进程

on run
    try
        set pidList to do shell script "lsof -ti:7860 2>/dev/null"
        if pidList is "" then
            display notification "拾字未在运行" with title "拾字"
            return
        end if

        -- 杀进程
        do shell script "lsof -ti:7860 | xargs kill 2>/dev/null"
        delay 0.5

        -- 清理 PID 文件
        do shell script "rm -f /tmp/shizi.pid"

        -- 二次确认杀干净
        try
            do shell script "lsof -ti:7860 2>/dev/null"
            -- 还有就强杀
            do shell script "lsof -ti:7860 | xargs kill -9 2>/dev/null"
        end try

        display notification "已停止" with title "拾字 · Voicetype Studio"
    on error
        display notification "拾字未在运行" with title "拾字"
    end try
end run
