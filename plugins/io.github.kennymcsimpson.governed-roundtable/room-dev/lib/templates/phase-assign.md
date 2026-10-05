本回合任务（分派）：起草任务单。每个执行席位一行：`- <seatId>: <任务> | 验收: ["node","--test","x.test.mjs"]`，写成文件后运行  {{roomCmd}} assign --seat {{seatDir}} --attempt {{attemptId}} --file <草案>。
不要自己动手改文件。草案解析失败会退回用户手填；用户确认后进入工作阶段。
