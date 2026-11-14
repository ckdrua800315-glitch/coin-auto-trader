export function continuousTail(rows,maxGap){
  let start=0;for(let i=1;i<rows.length;i++)if(rows[i].at-rows[i-1].at>maxGap)start=i;
  return rows.slice(start);
}
