export default [
  {
    "name": "getuser",
    "description": "Liệt kê thành viên nhóm, gom tối đa 20 thành viên mỗi tin và giãn cách ít nhất 1 giây",
    "syntax": "{p}getuser",
    "permission": "adminBox",
    "scope": "group",
    "countdown": 30,
    "icon": "👥",
    "type": 1,
    "author": "HHH",
    "active": true,
    "instanceScope": "any"
  },
  {
    "name": "qc",
    "description": "Gửi một tin quảng cáo riêng tới thành viên các nhóm đã chọn",
    "syntax": "{p}qc [status|stop]",
    "permission": "adminLevelHigh",
    "scope": "both",
    "countdown": 0,
    "icon": "📣",
    "type": 1,
    "author": "HHH",
    "active": true,
    "instanceScope": "any"
  }
];
