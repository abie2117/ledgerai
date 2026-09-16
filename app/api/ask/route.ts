async function askQuestion(question: string) {
  const trimmedQuestion = question.trim();

  if (!trimmedQuestion) {
    setAskAnswer('Please enter a question about your finances.');
    return;
  }

  if (!selectedClientId) {
    setAskAnswer('Please select a client first.');
    return;
  }

  setIsAsking(true);
  setAskAnswer('');

  try {
    const response = await fetch('/api/ask', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        question: trimmedQuestion,
        selectedClientId,
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      setAskAnswer(
        result.error ||
          'Unable to answer your question right now.',
      );
      return;
    }

    setAskAnswer(result.answer || 'No answer was returned.');
  } catch (error) {
    console.error('Ask question error:', error);

    setAskAnswer(
      'Unable to connect to the finance assistant. Please try again.',
    );
  } finally {
    setIsAsking(false);
  }
}

function handleAskQuestion() {
  void askQuestion(financeQuestion);
}

function handleSuggestedQuestion(question: string) {
  setFinanceQuestion(question);
  void askQuestion(question);
}