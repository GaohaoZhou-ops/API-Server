import base64
import struct
import unittest
import zlib
from unittest.mock import patch
import feedback
from feedback_images import validate, ImageError
import visit_email

def png():
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\0\xff\xff\xff')) + chunk(b'IEND', b'')

class MailTests(unittest.TestCase):
    def config(self):
        return visit_email.settings({'access': {'password': 'EXAMPLE_READER_PASSWORD'}, 'email': {
            'enabled': True, 'sender': 'sender@example.test', 'recipient': 'admin@example.test',
            'smtp_host': 'smtp.example.test', 'smtp_port': 465, 'smtp_security': 'ssl',
            'smtp_password': 'EXAMPLE_SMTP_PASSWORD', 'access_url': 'https://docs.example.test/'}})

    def test_five_screenshots_preserve_bytes_and_six_are_rejected(self):
        item = {'name': 'screenshot.png', 'type': 'image/png', 'data': base64.b64encode(png()).decode()}
        images = validate([item] * 5)
        self.assertEqual(len(images), 5)
        with self.assertRaises(ImageError):
            validate([item] * 6)
        with self.assertRaises(ImageError):
            validate([{**item, 'data': base64.b64encode(b'<script>invalid</script>').decode()}])
        record = {'id': 'test-record', 'email': 'reader@example.test', 'created_at': '2026-10-30T01:00:00Z',
                  'name': '<script>unsafe</script>', 'organization': 'Example', 'category': '其他',
                  'document_version': '1.0.0', 'message': 'Complete feedback\n' + 'line ' * 200}
        mail = feedback.message(self.config(), record, images)
        self.assertEqual(mail['To'], 'admin@example.test')
        self.assertEqual(len(list(mail.iter_attachments())), 5)
        self.assertTrue(all(part.get_payload(decode=True) == png() for part in mail.iter_attachments()))
        self.assertIn(record['message'], mail.get_body(preferencelist=('plain',)).get_content())
        html = mail.get_body(preferencelist=('html',)).get_content()
        self.assertIn('&lt;script&gt;', html)
        self.assertNotIn('<script>', html)

    def test_login_mail_has_html_plaintext_and_separate_history(self):
        event = {'time': '2026-10-30T01:00:00Z', 'username': 'Example', 'ip': '203.0.113.1',
                 'browser': 'Browser', 'os': 'Linux', 'loginType': 'shared', 'recentVisits': []}
        mail = visit_email.message(self.config(), event)
        self.assertIsNotNone(mail.get_body(preferencelist=('plain',)))
        html = mail.get_body(preferencelist=('html',)).get_content()
        self.assertIn('最近 10 次成功登录', html)
        self.assertIn('https://docs.example.test/', html)
        self.assertNotIn('<script', html)

    def test_both_smtp_modes_validate_tls_and_preserve_envelope(self):
        config = self.config()
        for security in ('ssl', 'starttls'):
            config['smtp_security'] = security
            with patch('visit_email.smtplib.SMTP_SSL') as ssl, patch('visit_email.smtplib.SMTP') as start:
                client = ssl.return_value if security == 'ssl' else start.return_value
                client.send_message.return_value = {}
                visit_email.deliver(config, 'test-message')
                client.login.assert_called_once_with('sender@example.test', 'EXAMPLE_SMTP_PASSWORD')
                client.send_message.assert_called_once_with('test-message', from_addr='sender@example.test', to_addrs=['admin@example.test'])
                if security == 'ssl':
                    self.assertTrue(ssl.call_args.kwargs['context'].check_hostname)
                else:
                    self.assertTrue(client.starttls.call_args.kwargs['context'].check_hostname)

if __name__ == '__main__':
    unittest.main()
