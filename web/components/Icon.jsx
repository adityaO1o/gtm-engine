// <Icon name="gauge" /> — mirrors the vanilla ic() helper (references the sprite symbols).
export default function Icon({ name, style }) {
  return (
    <svg className="ico" style={style}>
      <use href={`#i-${name}`} />
    </svg>
  );
}
