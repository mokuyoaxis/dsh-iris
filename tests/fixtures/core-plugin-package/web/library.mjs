// Module contract example only. Default Panel mounting is a subsequent slice.
export function mount({ container }) {
  const title = document.createElement('p'); title.textContent = 'Example library'; container.append(title);
  return () => title.remove();
}
