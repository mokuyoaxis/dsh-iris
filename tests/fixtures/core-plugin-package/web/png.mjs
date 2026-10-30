export function mount({ container, artifact }) {
  const label = document.createElement('p'); label.textContent = artifact.id; container.append(label);
  return () => label.remove();
}
