#!/bin/sh

fileprefix="/hmi/data/"
dateTime=$(date "+%Y%m%d%H%M%S")

pnCode=$(cat /hmi/pncode/pn.ini 2>/dev/null | head -n 1 | tr -d '\r\n')
[ -z "$pnCode" ] && pnCode="unknown"

ipAddr=$(ip addr show | awk '/inet / && $2 !~ /^127/ {sub(/\/.*/, "", $2); print $2; exit}')
[ -z "$ipAddr" ] && ipAddr="unknownip"

recordfile="${fileprefix}${pnCode}_${ipAddr}_${dateTime}.csv"


# 只在首次创建文件时写表头（保持你原来的表头不变，避免影响你后续解析）
if [ ! -f "$recordfile" ]; then
  touch "$recordfile"
  echo "node_pid,node_vmPeak,node_vmSize,node_vmHWM,node_vmRss,node_cpu,web_pid,web_vmPeak,web_vmSize,web_vmHWM,web_wmRSS,web_cpu,qtweb_pid,qtweb_vmPeak,qtweb_vmSize,qtweb_vmHWM,qtweb_wmRSS,qtweb_cpu,NewBm_pid,NewBm_vmPeak,NewBm_vmSize,NewBm_vmHWM,NewBm_vmRss,NewBm_cpu,uonline_pid,uonline_vmPeak,uonline_vmSize,uonline_vmHWM,uonline_vmRss,uonline_cpu,update_pid,update_vmPeak,update_vmSize,update_vmHWM,update_vmRss,update_vmCpu,timestamp,MemTotal,MemFree,Buffers,Cached,Slab,SReclaimable,SwapCached,SwapTotal,SwapFree,VmallocUsed,VmallocChunk,io_kw_s,uCam_pid,uCam_vmPeak,uCam_vmSize,uCam_vmHWM,uCam_vmRss,uCam_cpu" > "$recordfile"
fi

# ---------- 工具函数：不依赖 pgrep ----------
# 用 ps+grep 取第一个匹配的 PID（避免多行导致 CSV 错位）
get_pid() {
  # $1: grep pattern
  # busybox ps 通常只有一列 PID + CMD，这里用 NR==1 保证只取第一条
  ps 2>/dev/null | grep -v grep | grep "$1" | awk 'NR==1{print $1}'
}

get_pid_i() {
  # case-insensitive
  ps 2>/dev/null | grep -v grep | grep -i "$1" | awk 'NR==1{print $1}'
}

# 一次性从 /proc/$pid/status 取 VmPeak/VmSize/VmHWM/VmRSS（pid 不存在则全 0）
get_mem_stat_csv() {
  pid="$1"
  if [ -n "$pid" ] && [ -r "/proc/$pid/status" ]; then
    awk '
      /^VmPeak:/{p=$2$3}
      /^VmSize:/{s=$2$3}
      /^VmHWM:/{h=$2$3}
      /^VmRSS:/{r=$2$3}
      END{
        if(p=="")p=0; if(s=="")s=0; if(h=="")h=0; if(r=="")r=0;
        print p","s","h","r
      }' "/proc/$pid/status"
  else
    echo "0,0,0,0"
  fi
}

# 从一份 top 输出里按 PID 取 CPU（找不到就 0）
get_cpu_from_top() {
  pid="$1"
  top_cache="$2"
  if [ -z "$pid" ] || [ "$pid" = "0" ]; then
    echo "0"
    return
  fi
  # 你原脚本用 $7，当作 %CPU。这里保持一致；若 top 版本不同，可在此处调整列号
  cpu=$(echo "$top_cache" | awk -v p="$pid" '$1==p {print $7; exit}')
  [ -z "$cpu" ] && cpu="0"
  echo "$cpu"
}

# 一次性读取 meminfo（避免 10+ 次 cat/grep/awk）
get_meminfo_csv() {
  awk '
    $1=="MemTotal:"{MemTotal=$2$3}
    $1=="MemFree:"{MemFree=$2$3}
    $1=="Buffers:"{Buffers=$2$3}
    $1=="Cached:"{Cached=$2$3}
    $1=="Slab:"{Slab=$2$3}
    $1=="SReclaimable:"{SReclaimable=$2$3}
    $1=="SwapCached:"{SwapCached=$2$3}
    $1=="SwapTotal:"{SwapTotal=$2$3}
    $1=="SwapFree:"{SwapFree=$2$3}
    $1=="VmallocUsed:"{VmallocUsed=$2$3}
    $1=="VmallocChunk:"{VmallocChunk=$2$3}
    END{
      if(MemTotal=="")MemTotal=0;
      if(MemFree=="")MemFree=0;
      if(Buffers=="")Buffers=0;
      if(Cached=="")Cached=0;
      if(Slab=="")Slab=0;
      if(SReclaimable=="")SReclaimable=0;
      if(SwapCached=="")SwapCached=0;
      if(SwapTotal=="")SwapTotal=0;
      if(SwapFree=="")SwapFree=0;
      if(VmallocUsed=="")VmallocUsed=0;
      if(VmallocChunk=="")VmallocChunk=0;
      print MemTotal","MemFree","Buffers","Cached","Slab","SReclaimable","SwapCached","SwapTotal","SwapFree","VmallocUsed","VmallocChunk
    }' /proc/meminfo 2>/dev/null
}

# ---------- 采样逻辑：保持你原来的 iostat -d -x 1 10 ----------
io_kw_s=0
device_platform=$(uname -a 2>/dev/null | grep A40i)

while :; do
  # 采样磁盘（保持你原来逻辑不变：iostat 1s * 10 次）
  if [ -z "$device_platform" ]; then
    msg=$(iostat -d -x 1 10 2>/dev/null | grep -E 'mmcblk0p5' | awk '{print $7}')
  else
    msg=$(iostat -d -x 1 10 2>/dev/null | grep -E 'mmcblk0p8' | awk '{print $7}')
  fi

  sum=0
  for num in $msg; do
    # 避免空值
    [ -z "$num" ] && num=0
    sum=$(awk "BEGIN {print $sum + $num}")
  done

  # 保留你原来的计算形式，但加除零保护
  if awk -v s="$sum" 'BEGIN{exit !(s>0)}'; then
    io_kw_s=$(awk -v d="$sum" 'BEGIN {printf "%.2f\n", 4085.775585996956 / d}')
  else
    io_kw_s="0"
  fi

  # 一次 top 缓存（替代你原来每个进程都跑 top）
  TOP_CACHE=$(top -b -n 1 2>/dev/null)

  # 取 PID（ps + grep），只取第一条，避免多行破坏 CSV
  nod_pid=$(get_pid "nodejs")
  web_pid=$(get_pid_i "webengine")
  bm_pid=$(get_pid "backmanage")
  qtweb_pid=$(get_pid "QtWebEngineProcess")
  uonline_pid=$(get_pid "go_uOnline")
  update_pid=$(get_pid "go_update")
  uCam_pid=$(get_pid "uCameraServer")

  # CPU（从同一份 top 输出里取）
  nod_cpu=$(get_cpu_from_top "$nod_pid" "$TOP_CACHE")
  web_cpu=$(get_cpu_from_top "$web_pid" "$TOP_CACHE")
  bm_cpu=$(get_cpu_from_top "$bm_pid" "$TOP_CACHE")
  qtweb_cpu=$(get_cpu_from_top "$qtweb_pid" "$TOP_CACHE")
  uonline_cpu=$(get_cpu_from_top "$uonline_pid" "$TOP_CACHE")
  update_cpu=$(get_cpu_from_top "$update_pid" "$TOP_CACHE")
  uCam_cpu=$(get_cpu_from_top "$uCam_pid" "$TOP_CACHE")

  # /proc status（一次读完 4 个字段；进程不存在则 0）
  nod_mem=$(get_mem_stat_csv "$nod_pid")
  web_mem=$(get_mem_stat_csv "$web_pid")
  bm_mem=$(get_mem_stat_csv "$bm_pid")
  qtweb_mem=$(get_mem_stat_csv "$qtweb_pid")
  uonline_mem=$(get_mem_stat_csv "$uonline_pid")
  update_mem=$(get_mem_stat_csv "$update_pid")
  uCam_mem=$(get_mem_stat_csv "$uCam_pid")

  # 拆字段（VmPeak,VmSize,VmHWM,VmRSS）
  nod_vmpeak=$(echo "$nod_mem" | cut -d, -f1); nod_vmsize=$(echo "$nod_mem" | cut -d, -f2); nod_vmhwm=$(echo "$nod_mem" | cut -d, -f3); nod_vmrss=$(echo "$nod_mem" | cut -d, -f4)
  web_vmpeak=$(echo "$web_mem" | cut -d, -f1); web_vmsize=$(echo "$web_mem" | cut -d, -f2); web_vmhwm=$(echo "$web_mem" | cut -d, -f3); web_vmrss=$(echo "$web_mem" | cut -d, -f4)
  bm_vmpeak=$(echo "$bm_mem" | cut -d, -f1); bm_vmsize=$(echo "$bm_mem" | cut -d, -f2); bm_vmhwm=$(echo "$bm_mem" | cut -d, -f3); bm_vmrss=$(echo "$bm_mem" | cut -d, -f4)
  qtweb_vmpeak=$(echo "$qtweb_mem" | cut -d, -f1); qtweb_vmsize=$(echo "$qtweb_mem" | cut -d, -f2); qtweb_vmhwm=$(echo "$qtweb_mem" | cut -d, -f3); qtweb_vmrss=$(echo "$qtweb_mem" | cut -d, -f4)
  uonline_vmpeak=$(echo "$uonline_mem" | cut -d, -f1); uonline_vmsize=$(echo "$uonline_mem" | cut -d, -f2); uonline_vmhwm=$(echo "$uonline_mem" | cut -d, -f3); uonline_vmrss=$(echo "$uonline_mem" | cut -d, -f4)
  update_vmpeak=$(echo "$update_mem" | cut -d, -f1); update_vmsize=$(echo "$update_mem" | cut -d, -f2); update_vmhwm=$(echo "$update_mem" | cut -d, -f3); update_vmrss=$(echo "$update_mem" | cut -d, -f4)
  uCam_vmpeak=$(echo "$uCam_mem" | cut -d, -f1); uCam_vmsize=$(echo "$uCam_mem" | cut -d, -f2); uCam_vmhwm=$(echo "$uCam_mem" | cut -d, -f3); uCam_vmrss=$(echo "$uCam_mem" | cut -d, -f4)

  # meminfo（一次读完；修复你原脚本“Cached 丢失 / Slab 重复”导致的列错位）
  meminfo_csv=$(get_meminfo_csv)
  MemTotal=$(echo "$meminfo_csv" | cut -d, -f1)
  MemFree=$(echo "$meminfo_csv" | cut -d, -f2)
  Buffers=$(echo "$meminfo_csv" | cut -d, -f3)
  Cached=$(echo "$meminfo_csv" | cut -d, -f4)
  Slab=$(echo "$meminfo_csv" | cut -d, -f5)
  SReclaimable=$(echo "$meminfo_csv" | cut -d, -f6)
  SwapCached=$(echo "$meminfo_csv" | cut -d, -f7)
  SwapTotal=$(echo "$meminfo_csv" | cut -d, -f8)
  SwapFree=$(echo "$meminfo_csv" | cut -d, -f9)
  VmallocUsed=$(echo "$meminfo_csv" | cut -d, -f10)
  VmallocChunk=$(echo "$meminfo_csv" | cut -d, -f11)

  timeStamp=$(date +"%Y%m%d-%H%M%S")

  # 输出（字段顺序对齐表头；注意：表头里 web_wmRSS/qtweb_wmRSS/update_vmCpu 是历史拼写，这里保持列位置一致即可）
  echo "$nod_pid,$nod_vmpeak,$nod_vmsize,$nod_vmhwm,$nod_vmrss,$nod_cpu,$web_pid,$web_vmpeak,$web_vmsize,$web_vmhwm,$web_vmrss,$web_cpu,$qtweb_pid,$qtweb_vmpeak,$qtweb_vmsize,$qtweb_vmhwm,$qtweb_vmrss,$qtweb_cpu,$bm_pid,$bm_vmpeak,$bm_vmsize,$bm_vmhwm,$bm_vmrss,$bm_cpu,$uonline_pid,$uonline_vmpeak,$uonline_vmsize,$uonline_vmhwm,$uonline_vmrss,$uonline_cpu,$update_pid,$update_vmpeak,$update_vmsize,$update_vmhwm,$update_vmrss,$update_cpu,$timeStamp,$MemTotal,$MemFree,$Buffers,$Cached,$Slab,$SReclaimable,$SwapCached,$SwapTotal,$SwapFree,$VmallocUsed,$VmallocChunk,$io_kw_s,$uCam_pid,$uCam_vmpeak,$uCam_vmsize,$uCam_vmhwm,$uCam_vmrss,$uCam_cpu" >> "$recordfile"
done
