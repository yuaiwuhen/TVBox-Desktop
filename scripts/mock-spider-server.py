#!/usr/bin/env python3
"""
Mock Spider HTTP Server
用于在开发环境中模拟Spider服务，返回Mock数据
"""

from http.server import HTTPServer, BaseHTTPRequestHandler
import json

class MockSpiderHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def handle_request(self):
        # Health check
        if self.path == '/health':
            self.send_json_response({
                'success': True,
                'data': {
                    'status': 'ok',
                    'server': 'MockSpiderServer',
                    'version': '1.0.0'
                }
            })
            return

        # Mock home content
        if self.path == '/spider/homeContent':
            self.send_json_response({
                'success': True,
                'data': {
                    'classes': [
                        {'type_id': '1', 'type_name': '电影'},
                        {'type_id': '2', 'type_name': '电视剧'},
                        {'type_id': '3', 'type_name': '综艺'},
                        {'type_id': '4', 'type_name': '动漫'},
                    ],
                    'list': [
                        {
                            'vod_id': 'mock1',
                            'vod_name': '示例电影1（Mock数据）',
                            'vod_pic': 'https://via.placeholder.com/200x300?text=Movie+1',
                            'vod_remarks': 'HD',
                            'vod_year': '2024',
                            'type_id': '1',
                        },
                        {
                            'vod_id': 'mock2',
                            'vod_name': '示例电视剧（Mock数据）',
                            'vod_pic': 'https://via.placeholder.com/200x300?text=TV+Show',
                            'vod_remarks': '更新至第10集',
                            'vod_year': '2024',
                            'type_id': '2',
                        },
                    ]
                }
            })
            return

        # Mock category content
        if self.path == '/spider/categoryContent':
            self.send_json_response({
                'success': True,
                'data': {
                    'list': [
                        {
                            'vod_id': 'mock_cat1',
                            'vod_name': '分类内容示例',
                            'vod_pic': 'https://via.placeholder.com/200x300?text=Category',
                            'vod_remarks': 'HD',
                            'vod_year': '2024',
                        },
                    ],
                    'page': '1',
                    'pagecount': '10',
                }
            })
            return

        # Mock detail content
        if self.path == '/spider/detailContent':
            self.send_json_response({
                'success': True,
                'data': {
                    'list': [
                        {
                            'vod_id': 'mock1',
                            'vod_name': '详情内容示例（Mock数据）',
                            'vod_pic': 'https://via.placeholder.com/300x400?text=Detail',
                            'vod_content': '这是一个Mock数据',
                            'vod_play_from': '线路1',
                            'vod_play_url': '第01集#https://example.com/video.mp4',
                            'vod_year': '2024',
                        }
                    ]
                }
            })
            return

        # Default response
        self.send_json_response({
            'success': True,
            'data': 'Mock Spider Server'
        })

    def send_json_response(self, data):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

    def log_message(self, format, *args):
        print(f"[MockSpider] {args[0]}")

def main():
    port = 9979
    server = HTTPServer(('0.0.0.0', port), MockSpiderHandler)
    print(f"Mock Spider Server running on http://localhost:{port}")
    print("Press Ctrl+C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped")

if __name__ == '__main__':
    main()