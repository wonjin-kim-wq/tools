const test = require('node:test');
const assert = require('node:assert/strict');
const { createConversation } = require('../recommend');

const catalogue = [
  { id: 'quiz', name: '분수 퀴즈', grade: '4학년', subjects: ['수학'] },
  { id: 'team', name: '분수 모둠 게임', grade: '초등학교 4-5학년', subjects: ['수학'] },
  { id: 'other-topic', name: '소수 모둠 게임', grade: '5학년', subjects: ['수학'] },
  { id: 'middle', name: '분수 모둠 퍼즐', grade: '중학교 1-3학년', subjects: ['수학'] },
  { id: 'words', name: '영어 단어 카드', grade: '5학년', subjects: ['영어'] },
  { id: 'legacy', name: '타자 연습', grade: '전학년', short: '영어 단어 타자 연습' }
];
const ids = result => result.matches.map(({ app }) => app.id);

test('follow-up narrows the topic, updates grade and switches subject without carrying the old topic', () => {
  const { ask } = createConversation();
  assert.deepEqual(ids(ask('초4 수학 분수 수업에 쓸 앱 찾아줘', catalogue)), ['quiz', 'team']);
  assert.deepEqual(ids(ask('조별 활동은?', catalogue)), ['team']);
  assert.deepEqual(ids(ask('5학년으로 바꿔줘', catalogue)), ['team']);
  assert.deepEqual(ids(ask('중1은?', catalogue)), ['middle']);
  assert.deepEqual(ids(ask('초등 5학년 영어 수업은?', catalogue)), ['words', 'legacy']);
});

test('more results skip already shown apps and reset clears the conversation', () => {
  const apps = Array.from({ length: 5 }, (_, id) => ({ id, name: '수학 도구', subjects: ['수학'] }));
  const conversation = createConversation();
  assert.deepEqual(ids(conversation.ask('수학', apps)), [0, 1, 2]);
  assert.deepEqual(ids(conversation.ask('다른 앱은?', apps)), [3, 4]);
  assert.match(conversation.ask('더 있어?', apps).message, /아직 보여드리지 않은 웹앱이 없어요/);
  conversation.reset();
  assert.deepEqual(ids(conversation.ask('다른 앱은?', apps)), []);
  assert.deepEqual(ids(conversation.ask('수학', apps)), [0, 1, 2]);
});

test('keeps other conditions when clearing a grade and returns no unrelated result', () => {
  const { ask } = createConversation();
  assert.deepEqual(ids(ask('초등학교 6학년 분수 앱', catalogue)), []);
  assert.deepEqual(ids(ask('학년 상관없이', catalogue)), ['quiz', 'team']);
  assert.deepEqual(ids(ask('새 질문 화산 실험 앱 찾아줘', catalogue)), []);
});

test('generic words like 수업자료 do not block grade and subject matches', () => {
  const apps = [
    { id: 'eco', name: '생태몬스터', grade: '초등학교 2-6학년', subjects: ['국어', '수학', '과학'] },
    { id: 'pe', name: '체육교실', grade: '초등학교 1-6학년', subjects: ['체육'] },
    { id: 'high', name: '고학년 수학', grade: '초등학교 5-6학년', subjects: ['수학'] }
  ];
  for (const question of ['4학년 수학 수업자료 추천해줘', '4학년 수학수업자료', '4학년 수학 자료 있을까요?', '초4 수학 학습지 추천해 줄래?']) {
    assert.deepEqual(ids(createConversation().ask(question, apps)), ['eco'], question);
  }
  const loose = createConversation().ask('4학년 수학 분수 앱', apps);
  assert.deepEqual(ids(loose), ['eco']);
  assert.match(loose.message, /‘분수’에 딱 맞는 웹앱은 없어서/);
  assert.deepEqual(ids(createConversation().ask('4학년 미술 자료', apps)), []);
});
