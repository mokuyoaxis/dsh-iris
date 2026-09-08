/** 零网络 Provider fixture：用脚本化结果验证提交次数与调用顺序。 */
export class FakeSubmitProvider {
  constructor({ id, model, steps = [] }) {
    this.id = id;
    this.model = model;
    this.steps = [...steps];
    this.calls = [];
  }

  async submit(input, context) {
    this.calls.push({ input, context });
    if (!this.steps.length) throw new Error(`Fake Provider ${this.id} 没有剩余步骤`);
    const step = this.steps.shift();
    if (typeof step === 'function') return step(input, context);
    if (step && Object.prototype.hasOwnProperty.call(step, 'throw')) throw step.throw;
    return step && Object.prototype.hasOwnProperty.call(step, 'result') ? step.result : step;
  }
}
