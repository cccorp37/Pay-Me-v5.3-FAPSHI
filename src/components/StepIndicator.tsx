import React from 'react';
import { Check } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';

interface StepIndicatorProps {
  currentStep: 1 | 2 | 3;
  className?: string;
}

export default function StepIndicator({ currentStep, className = '' }: StepIndicatorProps) {
  const { t } = useLanguage();

  const steps = [
    { number: 1, label: t.stepper.step1 },
    { number: 2, label: t.stepper.step2 },
    { number: 3, label: t.stepper.step3 },
  ];

  const stepOfText = t.stepper.stepOf
    .replace('{current}', String(currentStep))
    .replace('{total}', '3');

  return (
    <div className={`w-full ${className}`}>
      {/* Step counter label & progress summary */}
      <div className="flex items-center justify-between mb-3 px-1">
        <span className="text-[11px] font-extrabold uppercase tracking-[0.15em] text-[#E8620A]">
          {stepOfText}
        </span>
        <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">
          {steps[currentStep - 1]?.label}
        </span>
      </div>

      {/* Visual Step Bar & Nodes */}
      <div className="relative flex items-center justify-between bg-white rounded-2xl p-4 border border-gray-100 shadow-[0_2px_12px_rgb(0,0,0,0.03)]">
        {/* Background Connecting Line */}
        <div className="absolute left-8 right-8 top-1/2 -translate-y-1/2 h-[3px] bg-gray-100 z-0">
          <div 
            className="h-full bg-[#E8620A] transition-all duration-500 ease-out rounded-full"
            style={{
              width: currentStep === 1 ? '0%' : currentStep === 2 ? '50%' : '100%'
            }}
          />
        </div>

        {/* Steps List */}
        {steps.map((step) => {
          const isCompleted = step.number < currentStep;
          const isActive = step.number === currentStep;

          return (
            <div key={step.number} className="relative z-10 flex flex-col items-center gap-1.5">
              <div
                className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-black transition-all duration-300 ${
                  isCompleted
                    ? 'bg-[#E8620A] text-white shadow-md shadow-orange-200'
                    : isActive
                    ? 'bg-[#1A1A1A] text-white ring-4 ring-orange-100 shadow-md'
                    : 'bg-white border-2 border-gray-200 text-gray-400'
                }`}
              >
                {isCompleted ? (
                  <Check size={16} strokeWidth={3} />
                ) : (
                  <span>{step.number}</span>
                )}
              </div>

              <span
                className={`text-[10px] font-bold tracking-tight uppercase whitespace-nowrap transition-colors ${
                  isActive
                    ? 'text-[#1A1A1A]'
                    : isCompleted
                    ? 'text-[#E8620A]'
                    : 'text-gray-400'
                }`}
              >
                {step.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
