// Runs on the public catalogue already loaded in the browser.
const AppRecommendations = (() => {
  const schools = { 초등: '초등학교', 중학: '중학교', 중등: '중학교', 고등: '고등학교' };
  const schoolPattern = /초등학교|중학교|고등학교|초등|중등|중학|고등/g;
  const gradePattern = /([1-6])\s*(?:학년\s*)?(?:[-~–∼]\s*([1-6])\s*)?학년/g;
  const subjects = {
    국어: ['국어'], 수학: ['수학'], 사회: ['사회'], 과학: ['과학'], 영어: ['영어'],
    도덕: ['도덕'], '실과(정보)': ['실과', '정보 교과', '정보 수업', '정보교육'],
    음악: ['음악'], 미술: ['미술'], 체육: ['체육'], 통합교과: ['통합교과', '통합 교과'],
    '창의적 체험활동': ['창의적 체험활동', '창체'], '교과 무관': ['교과 무관']
  };
  const categories = {
    '교과 교육': ['교과 교육', '교과교육'], '계기 교육': ['계기 교육', '계기교육'],
    아침활동: ['아침활동', '아침 활동'], 교실놀이: ['교실놀이', '교실 놀이'], 기타: ['기타']
  };
  const activities = {
    모둠: ['모둠', '모듬', '조별', '팀 활동', '팀전', '그룹', '협동', '협력'],
    개인: ['개인 활동', '개별', '혼자', '1인용', '개인별'],
    퀴즈: ['퀴즈', '문제 풀이', '문제풀이'],
    게임: ['게임', '놀이'],
    발표: ['발표', '프레젠테이션']
  };
  const fillers = new Set(('수업 활동 수업용 웹앱 웹 앱 도구 콘텐츠 컨텐츠 추천 추천해 추천해줘 추천해줄 추천해주세요 ' +
    '찾아 찾아줘 찾아주세요 알려 알려줘 알려주세요 보여줘 있나 있나요 있어 있어요 있는 없나 없나요 좀 뭐 무엇 무엇이 어떤 ' +
    '좋은 맞는 맞춰 위한 활용 활용할 사용 사용할 사용하기 쓸 쓰기 이용 할 활용하기 하고 싶은 하고싶은 만한 할만한 쓸만한 ' +
    '가능한 적합한 다른 하나 하나만 더 새로 이번 이번엔 이번에는 그러면 그럼 대신 좋아 부탁 전용 전학년 전체 모든 ' +
    '난 나는 안녕 안녕하세요 필요해 필요해요 해줘 주세요 준비 준비하는 대한 만 할수있는 하고싶어요 활동할 ' +
    '학년 으로 으로는 에서 에서는 에는 하고 하고는 까지 부터 더요 한거 건 거 ' +
    '바꿔 바꿔줘 바꿔주세요 바꾸면 별로 쓰는 써볼 함께 같이 교실 학급 반에서 ' +
    // '수업자료', '자료' 같은 말은 찾을 주제가 아니라 '무언가 추천해 달라'는 뜻이다
    '자료 수업자료 학습자료 교육자료 교수자료 수업용자료 학습 교구 교재 사이트 웹사이트 홈페이지 링크 프로그램 앱 어플 애플리케이션 ' +
    '수업에 수업할 수업시간 시간 시간에 때 쓸만한 볼만한 할만한거 추천좀 추천부탁 추천부탁해요 부탁해 부탁해요 추천해줄래 알려줄래 찾아줄래 ' +
    '줄래 줄래요 주실래요 주실 줘 줘요 줄 수 있어 있을까 있을까요 있니 있나 해줄 해줄래 해주실 학습지 활동지 워크시트').split(' '));
  const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase();
  const compact = value => normalize(value).replace(/[^가-힣a-z0-9]/g, '');
  const schoolOf = value => {
    const school = value.match(schoolPattern)?.at(-1);
    return schools[school] || school;
  };
  const gradeOf = value => {
    const match = [...value.matchAll(gradePattern)].at(-1);
    if (!match) return null;
    const first = Number(match[1]), last = Number(match[2] || match[1]);
    return [Math.min(first, last), Math.max(first, last)];
  };

  function pick(value, dictionary) {
    const joined = compact(value);
    return Object.entries(dictionary)
      .filter(([, aliases]) => aliases.some(alias => joined.includes(compact(alias))))
      .map(([label]) => label);
  }

  function parse(value) {
    const subject = pick(value, subjects);
    const category = pick(value, categories);
    let rest = value.replace(gradePattern, ' ').replace(schoolPattern, ' ')
      .replace(/전\s*학년|모든\s*학년|학년\s*상관\s*없이/g, ' ');
    for (const [labels, dictionary] of [[subject, subjects], [category, categories]]) {
      for (const label of labels) for (const alias of dictionary[label]) rest = rest.replaceAll(alias, ' ');
    }
    const activity = pick(rest, activities);
    for (const label of activity) for (const alias of activities[label]) rest = rest.replaceAll(alias, ' ');
    const words = (rest.match(/[가-힣a-z0-9]+/g) || [])
      .filter(word => !fillers.has(word))
      .map(word => {
        const stem = word.replace(/(?:으로는|에서는|으로|에서|에는|이나|하고|하고는|부터|까지|[을를은는이가에과와의로도만])$/, '')
          .replace(/(?:수업자료|학습자료|교육자료|자료|수업용|수업)$/, '');   // '분수수업자료' → '분수'
        return stem.length >= 2 || fillers.has(stem) ? stem : word;
      })
      .filter(word => word.length >= 2 && !fillers.has(word) && !/^\d+$/.test(word));
    return {
      school: schoolOf(value), grade: gradeOf(value), allGrades: /전\s*학년|모든\s*학년|학년\s*상관\s*없이/.test(value),
      subject, category, activity, topic: [...new Set(words)]
    };
  }

  function matchApp(app, context, softTopic = false) {
    const gradeText = normalize(app.grade);
    const school = schoolOf(gradeText) || '초등학교';
    const grade = gradeOf(gradeText);
    if (context.school && context.school !== school) return null;
    if (context.grade && grade && (grade[1] < context.grade[0] || grade[0] > context.grade[1])) return null;
    if (context.category.length && !context.category.includes(app.cat || app.category)) return null;
    const title = compact(app.name);
    const brief = compact(app.short);
    const description = compact(app.desc || app.description);
    const allText = title + ' ' + brief + ' ' + description;
    const matchedSubjects = context.subject.filter(label => {
      const known = app.subjects || [];
      return known.includes(label) || (!known.length && subjects[label].some(alias => allText.includes(compact(alias))));
    });
    if (context.subject.length && !matchedSubjects.length) return null;
    const matchedActivities = context.activity.filter(label => activities[label].some(alias => allText.includes(compact(alias))));
    if (context.activity.length && !matchedActivities.length) return null;
    const topics = context.topic.map(word => {
      const term = compact(word);
      return { word, points: title.includes(term) ? 6 : brief.includes(term) ? 4 : description.includes(term) ? 2 : 0 };
    }).filter(term => term.points);
    if (context.topic.length && !topics.length && !softTopic) return null;
    const gradeMatches = context.grade && (grade || /전\s*학년|모든\s*학년/.test(gradeText));
    return {
      app,
      labels: [...matchedSubjects, ...matchedActivities, ...topics.map(term => term.word)],
      score: topics.reduce((sum, term) => sum + term.points, 0) + matchedSubjects.length * 4 +
        matchedActivities.length * 3 + (gradeMatches ? 2 : 0)
    };
  }

  function createConversation() {
    let context, shown;
    function reset() {
      context = { subject: [], category: [], activity: [], topic: [] };
      shown = new Set();
    }
    reset();
    function ask(question, apps) {
      const value = normalize(question).trim().replace(/(?:^|\s)(초|중|고)([1-6])(?:학년)?(?=으로|[은는도]|[^가-힣0-9]|$)/g,
        (_, school, grade) => ` ${{ 초: '초등학교', 중: '중학교', 고: '고등학교' }[school]} ${grade}학년`);
      const fresh = /처음부터|새\s*질문|새\s*검색|다시\s*시작/.test(value);
      const more = /다른|더\s*(?:있|보여|추천|찾아|알려)|(?:^|\s)더[?!.\s]*$/.test(value);
      if (fresh) reset();
      const next = parse(value.replace(/처음부터|새\s*질문|새\s*검색|다시\s*시작/g, ' '));
      if (next.allGrades) next.grade = null;
      const hasCondition = next.school || next.grade || next.allGrades ||
        ['subject', 'category', 'activity', 'topic'].some(key => next[key].length);
      if (!hasCondition && !more) {
        return { message: '어떤 수업이나 활동에 쓰실 건가요? 학년, 교과 또는 주제를 알려 주세요.', matches: [] };
      }
      if (hasCondition) {
        const school = next.school || context.school;
        const subjectChanged = next.subject.length && !next.subject.every(label => context.subject.includes(label));
        const topicChanged = next.topic.length && next.topic.some(word => !context.topic.includes(word));
        const updated = {
          school,
          grade: next.allGrades ? null : next.grade || (next.school && next.school !== context.school ? null : context.grade),
          subject: next.subject.length ? next.subject : context.subject,
          category: next.category.length ? next.category : subjectChanged || topicChanged ? [] : context.category,
          activity: next.activity.length ? next.activity : subjectChanged || topicChanged ? [] : context.activity,
          topic: next.topic.length ? next.topic : subjectChanged ? [] : context.topic
        };
        if (JSON.stringify(updated) !== JSON.stringify(context)) shown.clear();
        context = updated;
      }
      const { school, grade, subject, category, activity, topic } = context;
      const gradeLabel = grade && (grade[0] === grade[1] ? `${grade[0]}학년` : `${grade.join('~')}학년`);
      const labels = [[school, gradeLabel].filter(Boolean).join(' '), ...subject, ...category, ...topic, ...activity].filter(Boolean);
      if (!labels.length) {
        return { message: '어떤 수업이나 활동에 쓰실 건가요? 학년, 교과 또는 주제를 알려 주세요.', matches: [] };
      }
      const conditions = labels.join(' · ');
      let ranked = apps.map(app => matchApp(app, context)).filter(Boolean).sort((a, b) => b.score - a.score);
      // 주제어까지 맞는 앱이 없어도 교과(또는 분류)가 맞는 앱이 있으면 그것을 추천한다(학년·학교급 조건은 그대로)
      let loose = false;
      if (!ranked.length && topic.length && (subject.length || category.length)) {
        ranked = apps.map(app => matchApp(app, context, true)).filter(Boolean).sort((a, b) => b.score - a.score);
        loose = ranked.length > 0;
      }
      const matches = ranked.filter(({ app }) => !more || !shown.has(app.id)).slice(0, 3);
      for (const { app } of matches) shown.add(app.id);
      const strict = [[school, gradeLabel].filter(Boolean).join(' '), ...subject, ...category, ...activity].filter(Boolean).join(' · ');
      const message = matches.length ? (loose ? `‘${topic.join(', ')}’에 딱 맞는 웹앱은 없어서 ${strict} 조건으로 찾았어요.` : `${conditions} 조건으로 찾았어요.`)
        : more && ranked.length ? `${conditions} 조건에서 아직 보여드리지 않은 웹앱이 없어요. 조건을 바꿔서 물어봐 주세요.`
        : `${conditions} 조건에 맞는 웹앱을 찾지 못했어요. 교과나 활동 조건을 바꿔서 물어봐 주세요.`;
      return { message, matches };
    }
    return { ask, reset };
  }

  return { createConversation };
})();

if (typeof module !== 'undefined') module.exports = AppRecommendations;
