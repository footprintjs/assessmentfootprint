export class AssessmentError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.name = 'AssessmentError'; this.status = status; }
}
