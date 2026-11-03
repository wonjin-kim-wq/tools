"""참코딩 일괄 업로드용 엑셀 양식을 만든다.

실행: python3 scripts/make-upload-template.py  (openpyxl 필요: pip install openpyxl)
결과: assets/chamcoding-upload-template.xlsx

열 이름은 tools.js의 엑셀 읽기(BULK_COLUMNS)와 같아야 한다. 열을 바꾸면 두 곳을 함께 고친다.
"""
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.worksheet.datavalidation import DataValidation

CATEGORIES = ['교과 교육', '계기 교육', '아침활동', '교실놀이', '기타']
SUBJECTS = ['국어', '수학', '사회', '과학', '영어', '도덕', '실과(정보)', '음악', '미술', '체육', '통합교과', '창의적 체험활동', '교과 무관']

# (열 이름, 필수, 너비, 작성 방법, 예시)
COLUMNS = [
    ('앱 이름', True, 20, '60자 이내.', 'Doodle ABC'),
    ('제작자 이름', True, 16, '이름 또는 연구회 이름. 같은 이름의 앱은 상세 화면의 "다른 앱"에 함께 보여요.', '참쌤스쿨'),
    ('웹앱 주소', True, 32, 'https://로 시작하는 공개 주소.', 'https://doodleabc.example.app/'),
    ('체험하기 주소', False, 28, '체험용 주소가 따로 있을 때만. https://', ''),
    ('소개 영상 주소', False, 32, '유튜브 링크 권장(일부 공개 가능). https://', 'https://youtu.be/xxxxxxxxxxx'),
    ('카테고리', True, 14, '목록 중 하나: ' + ', '.join(CATEGORIES), '교과 교육'),
    ('교과', True, 22, '쉼표(,)로 여러 개. 목록: ' + ', '.join(SUBJECTS), '영어, 미술'),
    ('적용 학년', True, 14, '예: 3-6학년, 전학년', '3-6학년'),
    ('대표 색상', False, 12, '#로 시작하는 6자리 색. 비우면 노랑.', '#5b8def'),
    ('한 줄 소개', True, 40, '160자 이내. 카드에 보이는 문장.', '친구가 그린 그림을 보고 알파벳 조각으로 영어 단어를 맞히는 실시간 교실 게임'),
    ('상세 설명', True, 60, '6000자 이내. 목적, 사용 방법, 준비물, 수업 활용 팁. 줄바꿈 가능.', '교실에서 다 같이 하는 그림 퀴즈 영어 단어 게임이에요.\n선생님이 방을 만들면 학생들은 6자리 코드나 QR로 들어와요.'),
    ('새로운 소식', False, 36, '한 줄에 하나씩(또는 | 로 구분), 최대 12개.', '모둠 대항전 모드 추가\n단어장 200개로 확장'),
    ('연락 이메일', False, 26, '관리자에게만 보여요.', 'teacher@school.kr'),
    ('이미지 파일', True, 32, '함께 올릴 이미지 파일 이름을 | 로 구분, 최대 6개. 첫 번째가 대표 썸네일(정사각형 권장).', 'doodle-thumb.png | doodle-1.png | doodle-2.png'),
    ('이미지 설명', True, 48, '이미지 파일과 같은 순서로 | 로 구분. 각 250자 이내.', '대표 썸네일 | 방 번호로 입장하는 화면 | 알파벳 조각으로 정답을 맞히는 화면'),
]

HEAD = PatternFill('solid', fgColor='191F28')
REQ = PatternFill('solid', fgColor='FFF1BB')
EXAMPLE = PatternFill('solid', fgColor='F2F4F6')
thin = Side(style='thin', color='DFE2E7')
BOX = Border(left=thin, right=thin, top=thin, bottom=thin)
WRAP = Alignment(wrap_text=True, vertical='top')

wb = Workbook()
ws = wb.active
ws.title = '웹앱 목록'
for i, (name, required, width, _, example) in enumerate(COLUMNS, start=1):
    head = ws.cell(row=1, column=i, value=name + (' *' if required else ''))
    head.font = Font(bold=True, color='FFFFFF')
    head.fill = HEAD
    head.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
    head.border = BOX
    ws.column_dimensions[head.column_letter].width = width
    sample = ws.cell(row=2, column=i, value=('(예시) ' + example) if i == 1 else example)
    sample.fill = EXAMPLE
    sample.alignment = WRAP
    sample.border = BOX
    for r in range(3, 53):
        cell = ws.cell(row=r, column=i)
        cell.alignment = WRAP
        cell.border = BOX
ws.row_dimensions[1].height = 30
ws.row_dimensions[2].height = 60
ws.freeze_panes = 'B2'

category = DataValidation(type='list', formula1='"' + ','.join(CATEGORIES) + '"', allow_blank=True, showErrorMessage=True,
                          errorTitle='카테고리', error='목록에 있는 카테고리를 골라 주세요.')
category.add('F2:F200')
ws.add_data_validation(category)

guide = wb.create_sheet('작성 안내')
guide.column_dimensions['A'].width = 16
guide.column_dimensions['B'].width = 8
guide.column_dimensions['C'].width = 70
guide.column_dimensions['D'].width = 40
guide['A1'] = '참코딩 일괄 업로드 양식 작성 안내'
guide['A1'].font = Font(bold=True, size=14)
guide['A2'] = '‘웹앱 목록’ 시트에 앱 하나를 한 줄로 적어요. 2번째 줄의 (예시)는 지우거나 그대로 두어도 돼요(앱 이름이 "(예시)"로 시작하는 줄은 읽지 않아요).'
guide['A3'] = '엑셀 파일과 ‘이미지 파일’ 열에 적은 이미지들을 참코딩 > 업로드 요청 > 엑셀로 한 번에 올리기에서 함께 선택하면 관리자 승인 대기로 등록돼요.'
for cell in ('A2', 'A3'):
    guide[cell].alignment = Alignment(wrap_text=False)
headers = ['항목', '필수', '작성 방법', '예시']
for i, text in enumerate(headers, start=1):
    c = guide.cell(row=5, column=i, value=text)
    c.font = Font(bold=True, color='FFFFFF')
    c.fill = HEAD
    c.border = BOX
for r, (name, required, _, how, example) in enumerate(COLUMNS, start=6):
    values = [name, '필수' if required else '선택', how, example]
    for i, text in enumerate(values, start=1):
        c = guide.cell(row=r, column=i, value=text)
        c.alignment = WRAP
        c.border = BOX
        if required and i == 2:
            c.fill = REQ

prompt_row = 6 + len(COLUMNS) + 2
guide.cell(row=prompt_row, column=1, value='AI에게 맡길 때 함께 줄 안내문').font = Font(bold=True, size=12)
prompt = (
    '첨부한 엑셀 양식의 ‘웹앱 목록’ 시트를 채워 줘. 앱 하나당 한 줄이고, 1행의 열 이름과 열 순서는 바꾸지 마. '
    '‘작성 안내’ 시트의 규칙을 지켜 줘: 필수 열(*)은 모두 채우고, 주소는 https://로 시작해야 해. '
    f'카테고리는 {", ".join(CATEGORIES)} 중 하나, 교과는 {", ".join(SUBJECTS)} 중에서 쉼표로 구분해 골라. '
    '이미지 파일은 실제로 함께 올릴 파일 이름을 | 로 구분해 최대 6개 적고(첫 번째가 대표 썸네일), 이미지 설명도 같은 순서로 | 로 구분해 적어. '
    '학생 이름 등 개인정보는 넣지 마. 2번째 줄 (예시)는 지워도 돼. 완성한 파일은 .xlsx로 저장해서 줘.\n\n'
    '[앱 정보]\n(여기에 앱 주소, 소개, 사용 방법, 이미지 파일 이름 등을 붙여 넣으세요)'
)
c = guide.cell(row=prompt_row + 1, column=1, value=prompt)
c.alignment = WRAP
guide.merge_cells(start_row=prompt_row + 1, start_column=1, end_row=prompt_row + 1, end_column=4)
guide.row_dimensions[prompt_row + 1].height = 110

wb.save('assets/chamcoding-upload-template.xlsx')
print('saved assets/chamcoding-upload-template.xlsx')
