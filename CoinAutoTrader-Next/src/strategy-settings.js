export const strategyCatalog=[
{id:'base-build',group:'신규 매수',name:'저점 기반 선행 탐색',detail:'완료 시간봉의 높은 저점과 실제 5분 체결 구조가 함께 상승할 때 10만 원 탐색. 현재 하락을 시간봉 신호로 무시하지 않습니다. 오전 3~9시 선행 탐색, 9시 30분 이후에도 기반 확인 시 탐색합니다.'},
{id:'open-impulse',group:'신규 매수',name:'오전 9시 초기 상승',detail:'9시 이전 실제 관찰 자료를 사용합니다. 이전 저항 위 최소 3초 지지와 실제 체결 가속 확인 후 10만 원 탐색. 기준가 대비 2.5% 초과 추격은 보류합니다.'},
{id:'trend-retest',group:'신규 매수',name:'상승 추세 재지지',detail:'15분 상승 구조 안에서 높은 저점과 실제 체결 회복을 확인합니다. 단순 하락 반등과 범위 상단은 제외합니다.'},
{id:'hold-rising',group:'보유 관리',name:'상승 지속 보유·보호 후 증액',detail:'실시간 저점 상승과 체결 우위가 유지되면 보유합니다. 순수익 1% 이상이며 손절선이 본전 이상으로 보호된 경우에만 설정 상한 안에서 한 차례 증액합니다.'},
{id:'scale-out',group:'보유 관리',name:'매수세 약화 시 분할 익절',detail:'순수익 2% 이상에서 실제 매수세 약화가 확인되면 절반 익절합니다. 지지선 이탈과 계좌 위험 청산은 선택과 관계없이 적용합니다.'}
];
export const defaultStrategies=strategyCatalog.map(v=>v.id);
export function validateStrategySettings(input){
if(!input||!Array.isArray(input.selected)||input.selected.some(v=>!defaultStrategies.includes(v))||new Set(input.selected).size!==input.selected.length)throw Error('새 전략만 중복 없이 선택하세요.');
if(!Number.isSafeInteger(input.orderCap)||input.orderCap<100000||input.orderCap>1000000)throw Error('회당 상한은 10만~100만 원 정수로 입력하세요.');
if(!Number.isSafeInteger(input.riskKrw)||input.riskKrw<1000||input.riskKrw>20000)throw Error('예상 손실 예산은 1천~2만 원 정수로 입력하세요.');
return {selected:[...input.selected],orderCap:input.orderCap,riskKrw:input.riskKrw};}
