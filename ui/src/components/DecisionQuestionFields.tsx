import { Check } from "lucide-react";
import type { WardmoteQuestionResponse, WardmoteQuestionSet } from "@tickernelz/wardmote-adapter-utils";
import { cn } from "../lib/utils";
import { answerError } from "./task-chat/QuestionForm";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

type Question = WardmoteQuestionSet["questions"][number];
export type DecisionQuestionAnswers = WardmoteQuestionResponse["answers"];

/** The question set an agent attached to a decision card, when it carries one. */
export function decisionQuestionSet(metadata: unknown): WardmoteQuestionSet | null {
  if (!metadata || typeof metadata !== "object") return null;
  const questionSet = (metadata as { questionSet?: WardmoteQuestionSet }).questionSet;
  return questionSet?.schema === "wardmote.question_set.v1" && Array.isArray(questionSet.questions) ? questionSet : null;
}

export function decisionQuestionsComplete(questionSet: WardmoteQuestionSet, answers: DecisionQuestionAnswers) {
  return questionSet.questions.every((question) => answerError(question, answers[question.id]) == null);
}

export function decisionQuestionResponse(answers: DecisionQuestionAnswers): WardmoteQuestionResponse {
  const filled = Object.entries(answers).filter(([, answer]) =>
    Boolean(answer.text?.trim() || answer.selectedOptionIds?.length),
  );
  return { schema: "wardmote.question_response.v1", answers: Object.fromEntries(filled) };
}

function QuestionChoice({
  label,
  description,
  recommended,
  selected,
  multiple,
  disabled,
  onClick,
}: {
  label: string;
  description?: string;
  recommended?: boolean;
  selected: boolean;
  multiple: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role={multiple ? "checkbox" : "radio"}
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-60",
        selected ? "bg-ink/5" : "hover:bg-bg-3/40",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border",
          multiple ? "rounded-sm" : "rounded-full",
          selected ? "border-accent bg-accent text-accent-ink" : "border-ink-3/50",
        )}
      >
        {selected ? (multiple ? <Check className="h-3 w-3" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium leading-5 text-ink">
          <span className="min-w-0 break-words">{label}</span>
          {recommended ? (
            <span className="rounded-sm bg-bg/70 px-1.5 py-0.5 text-(length:--text-micro) font-medium text-ink-3">Recommended</span>
          ) : null}
        </span>
        {description ? <span className="block break-words text-xs leading-4 text-ink-3">{description}</span> : null}
      </span>
    </button>
  );
}

function QuestionField({
  question,
  answer,
  disabled,
  onChange,
}: {
  question: Question;
  answer: DecisionQuestionAnswers[string] | undefined;
  disabled: boolean;
  onChange: (answer: DecisionQuestionAnswers[string]) => void;
}) {
  const error = answerError(question, answer);
  const hasValue = Boolean(answer?.text?.trim() || answer?.selectedOptionIds?.length);
  const inputType = question.textValidation?.inputType;
  const multiple = question.answerMode === "multi_select";
  const selected = new Set(answer?.selectedOptionIds ?? []);
  const toggle = (optionId: string) => {
    if (!multiple) {
      onChange({ selectedOptionIds: selected.has(optionId) && !question.required ? [] : [optionId] });
      return;
    }
    const next = new Set(selected);
    if (next.has(optionId)) next.delete(optionId);
    else next.add(optionId);
    onChange({ selectedOptionIds: (question.options ?? []).map((option) => option.id).filter((id) => next.has(id)) });
  };
  return (
    <fieldset className="min-w-0 space-y-1" data-decision-question={question.answerMode}>
      <legend className="text-xs font-medium text-ink-3">
        <span className="break-words">{question.prompt}</span>
        {question.required ? <span className="text-rose-500"> *</span> : null}
      </legend>
      {question.helpText ? <p className="whitespace-pre-wrap break-words text-xs text-ink-3">{question.helpText}</p> : null}
      {question.answerMode === "text" ? (
        inputType === "number" || inputType === "integer" ? (
          <Input
            type="number"
            inputMode={inputType === "integer" ? "numeric" : "decimal"}
            step={inputType === "integer" ? 1 : "any"}
            min={question.textValidation?.minimum}
            max={question.textValidation?.maximum}
            value={answer?.text ?? ""}
            disabled={disabled}
            aria-label={question.prompt}
            onChange={(event) => onChange({ text: event.target.value })}
            className="h-8 bg-bg text-sm"
          />
        ) : (
          <Textarea
            value={answer?.text ?? ""}
            disabled={disabled}
            aria-label={question.prompt}
            maxLength={question.textValidation?.maxLength}
            onChange={(event) => onChange({ text: event.target.value })}
            className="min-h-16 bg-bg text-sm"
          />
        )
      ) : (
        <div role={multiple ? "group" : "radiogroup"} aria-label={question.prompt} className="space-y-0.5">
          {(question.options ?? []).map((option) => (
            <QuestionChoice
              key={option.id}
              label={option.label}
              description={option.description}
              recommended={option.recommended}
              selected={selected.has(option.id)}
              multiple={multiple}
              disabled={disabled}
              onClick={() => toggle(option.id)}
            />
          ))}
        </div>
      )}
      {error && hasValue ? <p className="text-xs text-bad">{error}</p> : null}
    </fieldset>
  );
}

/** Every question of a decision card at once, so one action button submits them together. */
export function DecisionQuestionFields({
  questionSet,
  answers,
  disabled = false,
  onChange,
}: {
  questionSet: WardmoteQuestionSet;
  answers: DecisionQuestionAnswers;
  disabled?: boolean;
  onChange: (answers: DecisionQuestionAnswers) => void;
}) {
  return (
    <div className="mt-3 space-y-3" data-decision-questions="true">
      {questionSet.questions.map((question) => (
        <QuestionField
          key={question.id}
          question={question}
          answer={answers[question.id]}
          disabled={disabled}
          onChange={(answer) => onChange({ ...answers, [question.id]: answer })}
        />
      ))}
    </div>
  );
}
