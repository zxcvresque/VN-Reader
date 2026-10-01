/** Use the supplied VN artwork unchanged in both reading appearances. */
export default function BrandLogo({width=42}:{monochrome?:boolean;width?:number}) {
  return <span className="brand-logo" style={{width,height:width,display:"inline-grid",flexShrink:0}}>
    <img className="brand-logo-light" src="/VN%20Light%20Mode%20(Circle).png" alt="VN" width={width} height={width}/>
    <img className="brand-logo-dark" src="/VN%20Dark%20Mode%20(Circle).png" alt="VN" width={width} height={width}/>
  </span>;
}
