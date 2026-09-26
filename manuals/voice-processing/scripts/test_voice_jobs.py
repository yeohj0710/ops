"""Focused regression checks. Temporary fixtures stay below the supplied task folder."""
import argparse
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import voice_jobs as v

parser = argparse.ArgumentParser()
parser.add_argument('--scratch', required=True)
args, remaining = parser.parse_known_args()
SCRATCH = v.absolute(args.scratch)
SCRATCH.mkdir(parents=True, exist_ok=True)


class SafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=SCRATCH)
        self.root = Path(self.tmp.name)
        self.cfg = {'profiles': str(self.root / 'profiles.json'), 'tts_model': 'pinned-model'}
        self.src = self.root / 'a.txt'
        self.src.write_text('반갑습니다. 오늘 이야기를 시작할게요.', encoding='utf-8')

    def tearDown(self):
        self.tmp.cleanup()

    def make_plan(self, inputs=None, **options):
        values = dict(inputs=inputs or [str(self.src)], preset='female-bright', output_dir=str(self.root/'result'), start=0, duration=None, dry_run=False)
        values.update(options)
        with contextlib.redirect_stdout(io.StringIO()):
            v.plan(argparse.Namespace(**values), self.cfg)
        path = self.root/'result/etc/job-female-bright.json'
        return path, v.read_json(path) if path.exists() else None

    def test_dry_run_does_not_create_outputs(self):
        self.make_plan(dry_run=True)
        self.assertFalse((self.root/'result').exists())

    def test_colliding_names_are_rejected_before_writing(self):
        other = self.root/'other/a.txt'
        other.parent.mkdir()
        other.write_text('다른 대사', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, '이름이 같은'):
            self.make_plan([str(self.src), str(other)])
        self.assertFalse((self.root/'result').exists())

    def test_changed_source_requires_new_plan(self):
        _, job = self.make_plan()
        self.src.write_text('바뀐 대사', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, '원본이'):
            v.check_source(job['items'][0])

    def test_transcript_edit_invalidates_cache_and_survives_prepare(self):
        _, job = self.make_plan()
        item = job['items'][0]
        Path(item['scratch']).mkdir(parents=True)
        v.prepare_one(self.cfg, None, job, item)
        before = v.render_key(self.cfg, item, job['profile'])
        Path(item['transcript']).write_text('사람이 고친 대사입니다.', encoding='utf-8')
        after = v.render_key(self.cfg, item, job['profile'])
        self.assertNotEqual(before, after)
        v.prepare_one(self.cfg, None, job, item)
        self.assertEqual(Path(item['transcript']).read_text(encoding='utf-8'), '사람이 고친 대사입니다.')

    def test_changed_selection_cannot_reuse_old_transcript(self):
        _, job = self.make_plan()
        item = job['items'][0]
        Path(item['scratch']).mkdir(parents=True)
        v.prepare_one(self.cfg, None, job, item)
        item['start'] = 3
        with self.assertRaisesRegex(ValueError, '기존 대사'):
            v.prepare_one(self.cfg, None, job, item)
        with self.assertRaisesRegex(ValueError, '현재 입력'):
            v.render_one(self.cfg, None, job, item)

    def test_backup_keeps_original_bytes(self):
        before = self.src.read_bytes()
        saved = v.backup(self.src, self.root/'etc')
        self.src.write_text('새 내용', encoding='utf-8')
        self.assertEqual(Path(saved).read_bytes(), before)

    def test_two_workers_cannot_lock(self):
        with v.lock(self.root/'lock'):
            with self.assertRaisesRegex(RuntimeError, '다른 음성 작업'):
                with v.lock(self.root/'lock'):
                    pass
        with v.lock(self.root/'lock'):
            pass

    def test_profile_cannot_overwrite_default(self):
        v.write_json(self.cfg['profiles'], {'female-bright': {}})
        with self.assertRaisesRegex(ValueError, '기본 옵션'):
            v.profiles(self.cfg)

    def test_chunking_keeps_words_and_bounds(self):
        text = ' '.join(['긴 대사도 중간 내용을 잃으면 안 됩니다.'] * 25)
        pieces = v.chunks(text)
        self.assertTrue(all(len(x) <= 160 for x in pieces))
        self.assertEqual(' '.join(pieces).split(), text.split())

    def test_partial_failure_does_not_render_failed_prepare(self):
        import engines
        b = self.root/'b.txt'
        b.write_text('두 번째 파일입니다.', encoding='utf-8')
        path, job = self.make_plan([str(self.src), str(b)])
        self.cfg['lock'] = str(self.root/'lock')
        rendered = []
        def prepare(cfg, engine, job, item, **kwargs):
            if item['source'] == str(self.src):
                raise ValueError('시험 오류')
        def render(cfg, engine, job, item):
            rendered.append(item['id'])
        with patch.object(engines, 'Engines'), patch.object(v, 'prepare_one', prepare), patch.object(v, 'render_one', render), contextlib.redirect_stdout(io.StringIO()):
            code = v.batch(argparse.Namespace(command='run', job=str(path)), self.cfg)
        self.assertEqual(code, 1)
        self.assertEqual(rendered, ['b__female-bright'])
        self.assertEqual(v.read_json(path)['state'], 'partial_failed')

    def test_refresh_backs_up_edited_transcript(self):
        _, job = self.make_plan()
        item = job['items'][0]
        Path(item['scratch']).mkdir(parents=True)
        v.prepare_one(self.cfg, None, job, item)
        transcript = Path(item['transcript'])
        transcript.write_text('수정했던 대사', encoding='utf-8')
        old_hash = v.digest(transcript)
        v.prepare_one(self.cfg, None, job, item, refresh=True)
        saved = Path(item['scratch'])/'etc/backups'/old_hash[:16]/'대사.txt'
        self.assertEqual(saved.read_text(encoding='utf-8'), '수정했던 대사')
        self.assertEqual(transcript.read_text(encoding='utf-8').strip(), self.src.read_text(encoding='utf-8'))


if __name__ == '__main__':
    unittest.main(argv=['test_voice_jobs', *remaining])
